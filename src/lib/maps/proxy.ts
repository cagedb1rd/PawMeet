/** Fixed upstream and bounded SDK parameters; no caller-controlled URLs. */
const allowedPaths = new Set([
  "v3/log/init",
  "v3/place/around",
  "v3/geocode/regeo",
  "v3/assistant/coordinate/convert",
]);
const allowedParams = new Set([
  "key",
  "jscode",
  "callback",
  "output",
  "keywords",
  "location",
  "locations",
  "radius",
  "offset",
  "page",
  "extensions",
  "types",
  "city",
  "citylimit",
  "sortrule",
  "coordsys",
  "batch",
  "roadlevel",
  "homeorcorp",
  "platform",
  "logversion",
  "appname",
  "csid",
  "sdkversion",
  "_",
  "s",
  "r",
  "language",
  "children",
  "type_",
  "antiCrab",
  "eventId",
  "product",
  "t",
  "resolution",
  "mob",
  "vt",
  "dpr",
  "scale",
  "label",
  "value",
]);
export function proxyTarget(
  path: string[],
  search: URLSearchParams,
  key: string,
  code: string,
) {
  if (!allowedPaths.has(path.join("/"))) throw new Error("MAP_PATH_DENIED");
  if (search.toString().length > 3000) throw new Error("MAP_PARAMS_DENIED");
  const query = new URLSearchParams();
  for (const [name, value] of search) {
    // SDK Geocoder repeats key; discard all caller credentials before validation.
    if (name === "key" || name === "jscode") continue;
    if (
      !allowedParams.has(name) ||
      (query.has(name) && !(name === "s" && query.getAll(name).length < 2)) ||
      value.length > 800
    )
      throw new Error("MAP_PARAMS_DENIED");
    if (
      name === "callback" &&
      !/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(value)
    )
      throw new Error("MAP_CALLBACK_DENIED");
    query.append(name, value);
  }
  const limit = (name: string, max: number) => {
    const value = query.get(name);
    if (value !== null && (!/^\d+$/.test(value) || Number(value) > max))
      throw new Error("MAP_PARAMS_DENIED");
  };
  limit("offset", 20);
  limit("page", 1);
  limit("radius", 5000);
  if (query.get("batch") === "true") throw new Error("MAP_PARAMS_DENIED");
  query.set("key", key);
  query.set("jscode", code);
  const target = new URL(path.join("/"), "https://restapi.amap.com/");
  target.search = query.toString();
  return target;
}
export function sameMapOrigin(request: Request, configured: string) {
  try {
    const expected = new URL(configured).origin;
    if (new URL(request.url).origin !== expected) return false;
    if (request.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    return origin
      ? origin === expected
      : !!referer && new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
