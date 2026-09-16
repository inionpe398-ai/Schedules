import test from "node:test";
import assert from "node:assert/strict";
import { DulmsClient } from "../server/dulms-client.js";

test("login posts hidden ASP.NET fields and keeps server cookies", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) return new Response('<form><input type="hidden" name="__VIEWSTATE" value="token"><input name="txtname"><input name="txtPass"></form>', { headers: { "set-cookie": "ASP.NET_SessionId=abc; Path=/" } });
    return new Response("authenticated dashboard", { headers: { "content-type": "text/html" } });
  };
  const client = new DulmsClient({ username: "student", password: "secret", fetchImpl });
  await client.login();
  assert.match(String(calls[1].options.body), /__VIEWSTATE=token/);
  assert.match(String(calls[1].options.body), /txtname=student/);
  assert.match(String(calls[1].options.body), /type=1/);
  assert.doesNotMatch(JSON.stringify(calls), /console|logger/i);
});

test("stops on CAPTCHA and rejects HTML returned by JSON endpoints", async () => {
  const captchaClient = new DulmsClient({ username: "x", password: "y", fetchImpl: async () => new Response("<div>captcha</div>") });
  await assert.rejects(() => captchaClient.login(), /CAPTCHA/);
  const htmlClient = new DulmsClient({ fetchImpl: async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }) });
  await assert.rejects(() => htmlClient.json("/x"), /HTML instead of JSON/);
});
