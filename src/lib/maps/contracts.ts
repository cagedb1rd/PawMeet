export interface MapPoint {
  lng: number;
  lat: number;
  crs: "GCJ02";
}
export interface LngLat {
  getLng(): number;
  getLat(): number;
}
export interface MapEvent {
  lnglat: LngLat;
}
export interface MapInstance {
  on(name: string, callback: (event: MapEvent) => void): void;
  off(name: string, callback: (event: MapEvent) => void): void;
  setCenter(center: number[]): void;
  add(items: Overlay[]): void;
  remove(items: Overlay[]): void;
  destroy(): void;
}
export interface Overlay {
  on(name: string, callback: () => void): void;
}
export type ServiceCallback = (status: string, result: unknown) => void;
export interface AMapSDK {
  Map: new (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => MapInstance;
  Marker: new (options: Record<string, unknown>) => Overlay;
  Circle: new (options: Record<string, unknown>) => Overlay;
  PlaceSearch: new (options: Record<string, unknown>) => {
    searchNearBy(
      keyword: string,
      center: number[],
      radius: number,
      cb: ServiceCallback,
    ): void;
  };
  Geocoder: new (options: Record<string, unknown>) => {
    getAddress(point: number[], cb: ServiceCallback): void;
  };
  convertFrom(point: number[], type: "gps", cb: ServiceCallback): void;
}
declare global {
  interface Window {
    AMap?: AMapSDK;
    _AMapSecurityConfig?: { serviceHost: string };
  }
}
