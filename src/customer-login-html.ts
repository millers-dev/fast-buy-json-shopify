import { CUSTOMER_LOGIN_GRANT_SENTENCE } from "./customer-login-crypto.js";

export const CUSTOMER_LOGIN_INVALID_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in</title>
</head>
<body>
<p>This sign-in link is no longer valid.</p>
</body>
</html>
`;

export const CUSTOMER_LOGIN_CLOSE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in</title>
</head>
<body>
<p>You can close this page.</p>
</body>
</html>
`;

export function customerLoginPage(loginId: string, userCode: string): string {
  const action = `/api/fastbuyjson/auth/customer/login/${encodeURIComponent(loginId)}/continue`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in</title>
</head>
<body>
<p>Your code is <strong>${escapeHtml(userCode)}</strong>.</p>
<p>${escapeHtml(CUSTOMER_LOGIN_GRANT_SENTENCE)}</p>
<p>Continue only when this code matches the one your agent showed.</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit">Continue</button>
</form>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
