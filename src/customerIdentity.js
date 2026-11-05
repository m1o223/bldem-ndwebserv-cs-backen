// Customer identities never grant access to the existing staff/admin workspace.
export const activeCustomer = account => !!account && account.enabled === true &&
  (account.status === undefined || account.status === "active") &&
  (account.role === undefined || account.role === "user");

export function profileImage(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "lh3.googleusercontent.com" || /^lh\d+\.googleusercontent\.com$/.test(url.hostname)) ? url.href : null;
  } catch { return null; }
}

export const customerIdentity = account => ({
  id: String(account._id), displayName: account.displayName, email: account.email,
  profileImage: profileImage(account.profileImage), role: "user", status: "active",
});
