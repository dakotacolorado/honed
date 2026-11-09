import { createHash, randomBytes } from "node:crypto";
import { checkName, now, Refusal, type Caller } from "./domain.ts";
import type { Store } from "./store.ts";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Makes a token for `name` and keeps its hash; the token itself is returned once and never stored. */
export function createToken(store: Store, name: string, admin: boolean): string {
  checkName(name);
  if (store.tokens().some((t) => t.name === name)) throw new Refusal(`a token named ${name} already exists; revoke it first`, 409);
  const token = `honed_${randomBytes(24).toString("base64url")}`;
  store.addToken(name, hashToken(token), admin, now());
  return token;
}

/** Who a token speaks for, or null for a token honed never issued or has revoked. */
export function callerOf(store: Store, token: string | undefined): Caller | null {
  if (!token) return null;
  const t = store.tokenByHash(hashToken(token));
  return t ? { name: t.name, admin: t.admin } : null;
}

/** What an agent wrote is attributed to its token, with the role or task it gave, if any. */
export function authorOf(caller: Caller, local: boolean, given: string | undefined): string | undefined {
  const detail = given?.trim();
  if (local) return detail;
  return detail ? `${caller.name} (${detail})` : caller.name;
}
