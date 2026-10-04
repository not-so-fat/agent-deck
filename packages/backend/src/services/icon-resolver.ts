import fs from 'node:fs/promises';
import path from 'node:path';
import { getAgentDeckHome } from '../vault/yaml-sync';
import { guardedFetch } from '../lib/destination-guard';

const FETCH_TIMEOUT_MS = 8000;
const MAX_ICON_BYTES = 512 * 1024;

export type IconResolveResult = {
  iconPath: string | null;
  source: string | null;
  domain: string | null;
};

export function getServiceIconsDir(): string {
  return path.join(getAgentDeckHome(), 'icons');
}

export function getServiceIconPath(serviceId: string): string {
  return path.join(getServiceIconsDir(), `${serviceId}.ico`);
}

export async function serviceIconFileExists(serviceId: string): Promise<boolean> {
  try {
    await fs.access(getServiceIconPath(serviceId));
    return true;
  } catch {
    return false;
  }
}

export function serviceIconApiPath(serviceId: string): string {
  return `/api/services/${serviceId}/icon`;
}

export function credentialIconApiPath(credentialId: string): string {
  return `/api/credentials/${credentialId}/icon`;
}

export async function removeCachedIcon(entityId: string): Promise<void> {
  try {
    await fs.unlink(getServiceIconPath(entityId));
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
}

/** Derive likely product domains from an MCP server URL. */
export function brandingDomainsFromUrl(urlString: string): string[] {
  if (urlString.startsWith('local://')) {
    return [];
  }

  let hostname: string;
  try {
    hostname = new URL(urlString).hostname.toLowerCase();
  } catch {
    return [];
  }

  const domains = new Set<string>();
  domains.add(hostname);

  const stripped = hostname
    .replace(/^mcp\./, '')
    .replace(/^api\./, '')
    .replace(/^remote\./, '');

  if (stripped !== hostname) {
    domains.add(stripped);
  }

  if (hostname.includes('github')) {
    domains.add('github.com');
  }

  const parts = stripped.split('.').filter(Boolean);
  if (parts.length >= 2) {
    domains.add(parts.slice(-2).join('.'));
  }
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
    domains.add(parts.slice(-3).join('.'));
  }

  return [...domains];
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await guardedFetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'AgentDeck/1.0 (icon resolver)',
        Accept: 'image/*,*/*;q=0.8',
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readIconResponse(response: Response): Promise<Buffer | null> {
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_ICON_BYTES) {
    return null;
  }

  return Buffer.from(arrayBuffer);
}

function extractIconHref(html: string, pageUrl: string): string | null {
  const linkTags = html.match(/<link[^>]+>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/rel=["'][^"']*icon[^"']*["']/i.test(tag)) {
      continue;
    }
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (hrefMatch?.[1]) {
      try {
        return new URL(hrefMatch[1], pageUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function tryDirectFavicon(domain: string): Promise<{ buffer: Buffer; source: string } | null> {
  for (const scheme of ['https', 'http'] as const) {
    const faviconUrl = `${scheme}://${domain}/favicon.ico`;
    try {
      const response = await fetchWithTimeout(faviconUrl);
      const buffer = await readIconResponse(response);
      if (buffer) {
        return { buffer, source: faviconUrl };
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function tryHomepageIcon(domain: string): Promise<{ buffer: Buffer; source: string } | null> {
  const homepage = `https://${domain}/`;
  try {
    const response = await fetchWithTimeout(homepage, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const iconHref = extractIconHref(html, homepage);
    if (!iconHref) {
      return null;
    }

    const iconResponse = await fetchWithTimeout(iconHref);
    const buffer = await readIconResponse(iconResponse);
    if (buffer) {
      return { buffer, source: iconHref };
    }
  } catch {
    return null;
  }
  return null;
}

async function tryGoogleFavicon(domain: string): Promise<{ buffer: Buffer; source: string } | null> {
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    const response = await fetchWithTimeout(faviconUrl);
    const buffer = await readIconResponse(response);
    if (buffer && buffer.byteLength > 200) {
      return { buffer, source: faviconUrl };
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolveIconForUrl(urlString: string): Promise<{
  buffer: Buffer;
  source: string;
  domain: string;
} | null> {
  const domains = brandingDomainsFromUrl(urlString);
  if (domains.length === 0) {
    return null;
  }

  for (const domain of domains) {
    const direct = await tryDirectFavicon(domain);
    if (direct) {
      return { ...direct, domain };
    }

    const homepage = await tryHomepageIcon(domain);
    if (homepage) {
      return { ...homepage, domain };
    }

    const google = await tryGoogleFavicon(domain);
    if (google) {
      return { ...google, domain };
    }
  }

  return null;
}

export async function cacheIconForService(serviceId: string, urlString: string): Promise<IconResolveResult> {
  return cacheIconForEntity(serviceId, urlString);
}

export async function cacheIconForCredential(
  credentialId: string,
  urlString: string,
): Promise<IconResolveResult> {
  return cacheIconForEntity(credentialId, urlString);
}

async function cacheIconForEntity(entityId: string, urlString: string): Promise<IconResolveResult> {
  const resolved = await resolveIconForUrl(urlString);
  if (!resolved) {
    return { iconPath: null, source: null, domain: null };
  }

  const iconsDir = getServiceIconsDir();
  await fs.mkdir(iconsDir, { recursive: true });
  const iconPath = getServiceIconPath(entityId);
  await fs.writeFile(iconPath, resolved.buffer);

  return {
    iconPath,
    source: resolved.source,
    domain: resolved.domain,
  };
}
