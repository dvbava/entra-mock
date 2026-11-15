const defaultTenantId = import.meta.env.VITE_ENTRA_TENANT_ID;
const defaultClientId = import.meta.env.VITE_ENTRA_CLIENT_ID;
const authorityHost = import.meta.env.VITE_ENTRA_AUTHORITY_HOST;

export function getMsalConfig() {
  const tenantId = localStorage.getItem('override_tenant_id') || defaultTenantId;
  const clientId = localStorage.getItem('override_client_id') || defaultClientId;
  return {
    auth: {
      clientId,
      tenantId,
      authority: `${authorityHost}/${tenantId}`,
      redirectUri: import.meta.env.VITE_ENTRA_REDIRECT_URI,
      postLogoutRedirectUri: import.meta.env.VITE_ENTRA_POST_LOGOUT_REDIRECT_URI,
    },
  };
}

export function setAppOverride(tenantId, clientId) {
  if (tenantId) localStorage.setItem('override_tenant_id', tenantId.trim());
  if (clientId) localStorage.setItem('override_client_id', clientId.trim());
}
