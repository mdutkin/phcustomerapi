// Hashing helpers. Argon2id for passwords, SHA-256 for token/code fingerprints
// (we don't need work factor on already-random tokens).

import { hash, verify, argon2id } from "argon2";
import { createHash, randomBytes } from "node:crypto";

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return verify(hashed, plain);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomNumericCode(digits = 6): string {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  // crypto-strong: rejection sampling
  let n = 0;
  do {
    n = randomBytes(4).readUInt32BE(0);
  } while (n >= 2 ** 32 - ((2 ** 32) % (max - min)));
  return String(min + (n % (max - min)));
}
