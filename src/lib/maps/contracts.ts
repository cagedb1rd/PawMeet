// Phase 3 adapter boundary. Demo places are not live POIs.
export interface MapPoint {
  lng: number;
  lat: number;
  crs: "GCJ02";
}
export interface MapAdapter {
  mount(element: HTMLElement, center: MapPoint): Promise<void>;
  setMarkers(points: { id: string; point: MapPoint }[]): void;
  destroy(): void;
}
