import { expect } from "vitest";
import * as SU from "../../src/stepup.js";
/** Enrols the signed-in user in TOTP and passes a step-up check with a real code. */
export async function stepUp(app: any, cookie: string) {
  const en = await app.inject({ method: "POST", url: "/auth/step-up/enroll", headers: { cookie } });
  const secret = en.statusCode === 200 ? en.json().secret : null;
  expect(secret).toBeTruthy();
  const v = await app.inject({ method: "POST", url: "/auth/step-up/verify", headers: { cookie }, payload: { code: SU.totp(secret) } });
  expect(v.statusCode).toBe(200); expect(v.json().fresh).toBe(true);
  return secret as string;
}
