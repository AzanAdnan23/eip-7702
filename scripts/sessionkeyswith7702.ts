import "dotenv/config";
import {
  Address,
  createPublicClient,
  Hex,
  http,
  zeroAddress,
  parseUnits,
  encodeFunctionData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getUserOperationGasPrice } from "@zerodev/sdk/actions";
import { sepolia } from "viem/chains";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import {
  create7702KernelAccount,
  create7702KernelAccountClient,
} from "@zerodev/ecdsa-validator";
import {
  createZeroDevPaymasterClient,
  createKernelAccount,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  ParamCondition,
  toCallPolicy,
  CallPolicyVersion,
} from "@zerodev/permissions/policies";
import {
  ModularSigner,
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { ERC20Abi } from "../hooks/ERC20abi";

if (!process.env.ZERODEV_RPC) {
  throw new Error("ZERODEV_RPC is not set");
}

const ZERODEV_RPC = process.env.ZERODEV_RPC;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_3;

const QTI_TOKEN_ADDRESS = "0x4b8e4BAB8671F699036414B09434c3AaeF9CbCee";

// We use the Sepolia testnet here, but you can use any network that
// supports EIP-7702.
const chain = sepolia;

const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const callPolicy = toCallPolicy({
  policyVersion: CallPolicyVersion.V0_0_4,
  permissions: [
    {
      target: QTI_TOKEN_ADDRESS,
      valueLimit: BigInt(0),
      abi: ERC20Abi,
      functionName: "transfer",
      args: [
        {
          condition: ParamCondition.NOT_EQUAL,
          value: zeroAddress,
        },
        {
          condition: ParamCondition.LESS_THAN_OR_EQUAL,
          value: parseUnits("10", 18),
        },
      ],
    },
  ],
});

const main = async () => {
  const signer = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);

  const sessionPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPrivateKey as Address);

  const sessionKeySigner = await toECDSASigner({
    signer: sessionAccount,
  });

  console.log("EOA Address:", signer.address);
  console.log("/n Generating Session Key... ");
  console.log("Session Key Address:", sessionAccount.address);

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionKeySigner,
    policies: [callPolicy],
  });
  const masterEcdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: signer,
    entryPoint,
    kernelVersion,
  });

  const account = await create7702KernelAccount(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });

  const sessionKeyKernelAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: {
      sudo: masterEcdsaValidator,
      regular: permissionPlugin,
    },
    kernelVersion: kernelVersion,
    address: account.address,
  });

  const paymasterClient = createZeroDevPaymasterClient({
    chain,
    transport: http(ZERODEV_RPC),
  });

  const kernelClient = create7702KernelAccountClient({
    account,
    chain,
    bundlerTransport: http(ZERODEV_RPC),
    paymaster: paymasterClient,
    client: publicClient,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },
  });
  const sessionKernelClient = createKernelAccountClient({
    account: sessionKeyKernelAccount,
    chain: chain,
    bundlerTransport: http(ZERODEV_RPC),
    paymaster: {
      getPaymasterData(userOperation) {
        return paymasterClient.sponsorUserOperation({ userOperation });
      },
    },
  });
  const tx = await sessionKernelClient?.sendTransaction({
    calls: [
      {
        to: QTI_TOKEN_ADDRESS,
        value: BigInt(0),
        data: encodeFunctionData({
          abi: ERC20Abi,
          functionName: "transfer",
          args: [sessionAccount.address, parseUnits("10", 18)],
        }),
      },
    ],
  });

  console.log("tx recipt: ", tx);

  // const impleAddress = kernelClient.account.accountImplementationAddress;
  // const entrypointAddress = kernelClient.account.entryPoint.address;
  // console.log("EOA Implementation Address:", impleAddress);

  // const userOpHash = await kernelClient.sendUserOperation({
  //   callData: await kernelClient.account.encodeCalls([
  //     {
  //       to: zeroAddress,
  //       value: BigInt(0),
  //       data: "0x",
  //     },
  //     {
  //       to: zeroAddress,
  //       value: BigInt(0),
  //       data: "0x",
  //     },
  //   ]),
  // });
  // console.log("EntryPoint Address:", entrypointAddress);
  // console.log("UserOp sent:", userOpHash);
  // console.log("Waiting for UserOp to be completed...");

  // const { receipt } = await kernelClient.waitForUserOperationReceipt({
  //   hash: userOpHash,
  // });
  // console.log(
  //   "UserOp completed",
  //   `${chain.blockExplorers.default.url}/tx/${receipt.transactionHash}`
  // );

  process.exit(0);
};

main();
