import "dotenv/config";
import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
  addressToEmptyAccount,
} from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { http, Hex, createPublicClient, Address, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import {
  ModularSigner,
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

if (!process.env.ZERODEV_RPC || !process.env.PRIVATE_KEY) {
  throw new Error("ZERODEV_RPC or PRIVATE_KEY is not set");
}

const publicClient = createPublicClient({
  transport: http(process.env.ZERODEV_RPC),
  chain: sepolia,
});

const signer = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
const entryPoint = getEntryPoint("0.7");

const getApproval = async (sessionKeyAddress: Address) => {
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    entryPoint,
    signer,
    kernelVersion: KERNEL_V3_1,
  });

  const emptyAccount = addressToEmptyAccount(sessionKeyAddress);
  const emptySessionKeySigner = await toECDSASigner({ signer: emptyAccount });

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint,
    signer: emptySessionKeySigner,
    policies: [toSudoPolicy({})],
    kernelVersion: KERNEL_V3_1,
  });

  const sessionKeyAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: {
      sudo: ecdsaValidator,
      regular: permissionPlugin,
    },
    kernelVersion: KERNEL_V3_1,
  });

  return await serializePermissionAccount(sessionKeyAccount);
};

const useSessionKey = async (
  approval: string,
  sessionKeySigner: ModularSigner
) => {
  const sessionKeyAccount = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    KERNEL_V3_1,
    approval,
    sessionKeySigner
  );

  const kernelPaymaster = createZeroDevPaymasterClient({
    chain: sepolia,
    transport: http(process.env.ZERODEV_RPC),
  });
  const kernelClient = createKernelAccountClient({
    account: sessionKeyAccount,
    chain: sepolia,
    bundlerTransport: http(process.env.ZERODEV_RPC),
    paymaster: {
      getPaymasterData(userOperation) {
        return kernelPaymaster.sponsorUserOperation({ userOperation });
      },
    },
  });

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await sessionKeyAccount.encodeCalls([
      {
        to: zeroAddress,
        value: BigInt(0),
        data: "0x",
      },
    ]),
  });

  console.log("userOp hash:", userOpHash);

  const _receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  console.log({ txHash: _receipt.receipt.transactionHash });
};

const revokeSessionKey = async (sessionKeyAddress: Address) => {
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    entryPoint,
    signer,
    kernelVersion: KERNEL_V3_1,
  });
  const sudoAccount = await createKernelAccount(publicClient, {
    plugins: {
      sudo: ecdsaValidator,
    },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
  });

  const kernelPaymaster = createZeroDevPaymasterClient({
    chain: sepolia,
    transport: http(process.env.ZERODEV_RPC),
  });
  const sudoKernelClient = createKernelAccountClient({
    account: sudoAccount,
    chain: sepolia,
    bundlerTransport: http(process.env.ZERODEV_RPC),
    paymaster: kernelPaymaster,
  });

  const emptyAccount = addressToEmptyAccount(sessionKeyAddress);
  const emptySessionKeySigner = await toECDSASigner({ signer: emptyAccount });

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint,
    signer: emptySessionKeySigner,
    policies: [toSudoPolicy({})],
    kernelVersion: KERNEL_V3_1,
  });

  const unInstallUserOpHash = await sudoKernelClient.uninstallPlugin({
    plugin: permissionPlugin,
  });
  console.log({ unInstallUserOpHash });
  const txReceipt = await sudoKernelClient.waitForUserOperationReceipt({
    hash: unInstallUserOpHash,
  });
  console.log({ unInstallTxHash: txReceipt.receipt.transactionHash });
};

const main = async () => {
  const sessionPrivateKey = generatePrivateKey();
  const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);

  const sessionKeySigner = await toECDSASigner({
    signer: sessionKeyAccount,
  });

  // The owner approves the session key by signing its address and sending
  // back the signature
  const approval = await getApproval(sessionKeySigner.account.address);

  // The agent constructs a full session key
  await useSessionKey(approval, sessionKeySigner);

  // revoke session key
  await revokeSessionKey(sessionKeySigner.account.address);
};

main();
