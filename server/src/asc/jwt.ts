import { SignJWT, importPKCS8 } from "jose";
import { readFileSync } from "node:fs";

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  /** Path to the AuthKey_XXXX.p8 file downloaded from App Store Connect. */
  privateKeyPath: string;
}

export function credentialsFromEnv(): AscCredentials {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKeyPath = process.env.ASC_KEY_PATH;
  if (!keyId || !issuerId || !privateKeyPath) {
    throw new Error(
      "Missing App Store Connect credentials. Set ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_PATH (path to your .p8 key)."
    );
  }
  return { keyId, issuerId, privateKeyPath };
}

/**
 * Mint a short-lived ES256 JWT for the App Store Connect API.
 * Apple caps token lifetime at 20 minutes; we use 15 and cache until near expiry.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function ascToken(creds: AscCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - now > 60) return cached.token;

  const pem = readFileSync(creds.privateKeyPath, "utf8");
  const key = await importPKCS8(pem, "ES256");
  const exp = now + 15 * 60;
  const token = await new SignJWT({ aud: "appstoreconnect-v1" })
    .setProtectedHeader({ alg: "ES256", kid: creds.keyId, typ: "JWT" })
    .setIssuer(creds.issuerId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);

  cached = { token, expiresAt: exp };
  return token;
}
