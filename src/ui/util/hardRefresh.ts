// Force the PWA to fetch the latest build from the server: unregister the
// service worker, drop its precaches, then reload from the network. This is the
// "empty cache and hard reload" you'd otherwise have to do by deleting and
// re-adding the bookmark.
//
// SAFE: league saves live in IndexedDB, which this does NOT touch — only the
// cached app shell (HTML/JS/CSS assets) is cleared and re-downloaded.
export const hardRefresh = async () => {
	try {
		const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
		await Promise.all(regs.map((r) => r.unregister()));
	} catch {
		// no service worker / unsupported — fine, the reload below still helps
	}

	try {
		if (self.caches) {
			const keys = await caches.keys();
			await Promise.all(keys.map((k) => caches.delete(k)));
		}
	} catch {
		// CacheStorage unavailable — ignore
	}

	// With the SW gone and caches cleared, a normal reload re-fetches the app
	// shell from the server (index.html revalidates and pulls the new bundle).
	window.location.reload();
};
