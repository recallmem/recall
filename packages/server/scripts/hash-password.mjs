#!/usr/bin/env node
// Prints a password hash for RECALL_REVIEWER_PASSWORD_HASH (format: scrypt$N$salt$hash).
// Reads the password from stdin so it never lands in shell history:
//
//   printf '%s' "$PASSWORD" | node scripts/hash-password.mjs
import { randomBytes, scryptSync } from "node:crypto";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (password.length < 16) {
  console.error("Use a password of at least 16 characters (a generated one is best).");
  process.exit(1);
}
const n = 16384;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N: n, r: 8, p: 1 });
console.log(`scrypt$${n}$${salt.toString("base64")}$${hash.toString("base64")}`);
