import { AscCredentials, ascToken, credentialsFromEnv } from "./jwt.js";

const BASE = "https://api.appstoreconnect.apple.com/v1";

export class AscClient {
  constructor(private creds: AscCredentials = credentialsFromEnv()) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await ascToken(this.creds);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ASC API ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  // ---- Convenience wrappers over the endpoints Agent Debut uses most ----

  listApps() {
    return this.get<any>("/apps?limit=50&fields[apps]=name,bundleId,sku,primaryLocale");
  }

  appVersions(appId: string) {
    return this.get<any>(
      `/apps/${appId}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState,platform,createdDate`
    );
  }

  builds(appId: string) {
    return this.get<any>(
      `/builds?filter[app]=${appId}&limit=10&sort=-uploadedDate&fields[builds]=version,processingState,uploadedDate,expired`
    );
  }

  createVersion(appId: string, versionString: string, platform = "IOS") {
    return this.post<any>("/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform, versionString },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    });
  }

  submitForReview(versionId: string) {
    return this.post<any>("/appStoreVersionSubmissions", {
      data: {
        type: "appStoreVersionSubmissions",
        relationships: {
          appStoreVersion: {
            data: { type: "appStoreVersions", id: versionId },
          },
        },
      },
    });
  }
}
