const BASE_URL = "https://dulms.deltauniv.edu.eg";

function hiddenFields(html) {
  const result = {};
  for (const match of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
    if (name) result[name] = value.replace(/&amp;/g, "&");
  }
  return result;
}

export class DulmsClient {
  constructor({ username, password, fetchImpl = fetch } = {}) {
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.cookies = new Map();
  }

  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "); }
  captureCookies(response) {
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  async request(path, options = {}, retry = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      let url = new URL(path, BASE_URL);
      let requestOptions = { ...options };
      let response;
      for (let redirects = 0; redirects <= 10; redirects += 1) {
        response = await this.fetchImpl(url, {
          ...requestOptions,
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "DentistryScheduleSync/1.0", ...(requestOptions.headers || {}), Cookie: this.cookieHeader() },
        });
        this.captureCookies(response);
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;
        url = new URL(location, url);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && String(requestOptions.method || "GET").toUpperCase() === "POST")) {
          const headers = { ...(requestOptions.headers || {}) };
          delete headers["Content-Type"];
          requestOptions = { method: "GET", headers };
        }
      }
      if (!response) throw new Error("DULMS returned no response");
      if (retry && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return this.request(path, options, false);
      }
      if (!response.ok) throw new Error(`DULMS request failed (${response.status})`);
      return response;
    } finally { clearTimeout(timer); }
  }

  async login() {
    if (!this.username || !this.password) throw new Error("DULMS_USERNAME and DULMS_PASSWORD are required");
    const page = await this.request("/login.aspx");
    const html = await page.text();
    if (/captcha|g-recaptcha|two.factor|otp/i.test(html)) throw new Error("DULMS requires CAPTCHA/MFA; automated sync was stopped");
    const body = new URLSearchParams({
      ...hiddenFields(html),
      txtname: this.username,
      txtPass: this.password,
      type: "1",
      Button1: "Login",
    });
    const response = await this.request("/login.aspx", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE_URL}/login.aspx` },
      body,
    });
    const result = await response.text();
    if (/id=["']txtname["']|name=["']txtPass["']/i.test(result) || response.url.includes("login.aspx")) {
      throw new Error("DULMS login failed; verify server credentials or authentication flow");
    }
  }

  async json(path, method = "GET") {
    const response = await this.request(path, { method, headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
    const type = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!type.includes("json") || /^\s*</.test(text)) throw new Error("DULMS returned HTML instead of JSON; session expired");
    return JSON.parse(text);
  }

  catalog() { return this.json("/CourseHistory/GetProgramsubjects_forReg", "POST"); }
  intervals() { return this.json("/Registered/GetAllIntervals", "POST"); }
  sessionTypes() { return this.json("/Registered/GetAllHoursDistribution", "POST"); }
  schedule(courseId) { return this.json(`/Registered/GetCourseSchedual?CourseId=${encodeURIComponent(courseId)}`); }
}
