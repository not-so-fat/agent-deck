/** Exchange bootstrap nonce from URL for HttpOnly dashboard session cookie. */
export async function bootstrapDashboardSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const nonce = params.get('bootstrap');
  if (!nonce) {
    return;
  }

  try {
    const response = await fetch('/api/dashboard-auth/bootstrap/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });

    if (!response.ok) {
      console.warn('[agent-deck] Dashboard bootstrap failed:', response.status);
    }
  } finally {
    // A nonce is a one-shot credential. Never leave a stale or consumed value in
    // the address bar, even when the exchange fails.
    params.delete('bootstrap');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', next);
  }
}
