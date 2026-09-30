// Public references only. Tokens, billing instruments, and Graph payloads stay outside this contract.
export function metaAssetInventory({ connections, adAccounts, pixels = [], datasets = [], selectedAdAccountId = "" }) {
  const businesses = new Map();
  for (const account of adAccounts) {
    if (account.business?.id) businesses.set(String(account.business.id), {
      id: String(account.business.id), name: String(account.business.name || ""),
    });
  }
  return {
    businesses: [...businesses.values()],
    adAccounts: adAccounts.map((account) => ({
      id: account.id, graphId: account.graphId, name: account.name,
      businessId: account.business?.id ? String(account.business.id) : null,
      currency: account.currency, timezone: account.timezone,
      accountStatus: account.accountStatus, disableReason: account.disableReason,
    })),
    pages: connections.map((connection) => ({
      connectionId: connection.id, id: connection.pageId, name: connection.pageName,
      tasks: connection.tasks,
      instagramIdentity: connection.instagramUserId
        ? { id: connection.instagramUserId, username: connection.instagramUsername }
        : null,
    })),
    dataSources: [
      ...pixels.map((pixel) => ({ type: "pixel", id: pixel.id, name: pixel.name, adAccountId: selectedAdAccountId })),
      ...datasets.map((dataset) => ({ type: "dataset", id: dataset.id, name: dataset.name, adAccountId: selectedAdAccountId })),
    ],
    billingProvider: "meta",
  };
}

export function assertMetaAssetSelection({ connection, account, pixel, adAccountId, pixelId = "" }) {
  if (!connection) throw new Error("meta_connection_not_found");
  if (!account || String(account.id) !== String(adAccountId)) throw new Error("meta_ad_account_unavailable");
  if (pixelId && (!pixel || String(pixel.id) !== String(pixelId))) throw new Error("meta_pixel_unavailable");
  return {
    connectionId: connection.id,
    businessId: account.business?.id ? String(account.business.id) : "",
    adAccountId: account.id,
    pageId: connection.pageId,
    instagramUserId: connection.instagramUserId || "",
    pixelId: pixelId || "",
    billingProvider: "meta",
  };
}
