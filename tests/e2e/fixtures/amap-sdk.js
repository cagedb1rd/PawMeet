/* Explicit SDK fixture: no live map, POI, coordinates or tiles are requested. */
(() => {
  const lnglat = (lng, lat) => ({ getLng: () => lng, getLat: () => lat });
  class Map {
    constructor(element, options) {
      this.element = element;
      this.options = options;
      this.listeners = {};
      element.dataset.mockMap = "true";
      document.body.dataset.mapsCreated = String(
        Number(document.body.dataset.mapsCreated || 0) + 1,
      );
      this.click = () =>
        this.listeners.click?.({ lnglat: lnglat(120.208, 30.214) });
      element.addEventListener("click", this.click);
      setTimeout(() => this.listeners.complete?.({}), 15);
    }
    on(name, callback) {
      this.listeners[name] = callback;
    }
    off(name) {
      delete this.listeners[name];
    }
    setCenter(center) {
      this.element.dataset.center = center.join(",");
    }
    add(items) {
      for (const item of items)
        if (item.options.content)
          this.element.appendChild(item.options.content);
    }
    remove(items) {
      for (const item of items) item.options.content?.remove();
    }
    destroy() {
      this.element.removeEventListener("click", this.click);
      this.element.replaceChildren();
      this.listeners = {};
      document.body.dataset.mapsDestroyed = String(
        Number(document.body.dataset.mapsDestroyed || 0) + 1,
      );
    }
  }
  class Overlay {
    constructor(options) {
      this.options = options;
    }
    on() {}
  }
  class PlaceSearch {
    constructor() {}
    searchNearBy(keyword, center, radius, callback) {
      document.body.dataset.searchCenter = center.join(",");
      const delay = keyword === "慢查询" ? 1200 : 20;
      setTimeout(() => {
        if (keyword === "失败") return callback("error", {});
        if (keyword === "空结果") return callback("no_data", {});
        callback("complete", {
          poiList: {
            pois: [
              {
                id: "B-MOCK-ONLY",
                name: `测试${keyword}（SDK mock）`,
                address: "测试公共入口，不代表真实POI",
                adname: "滨江区",
                location: lnglat(120.208, 30.214),
              },
            ],
          },
        });
      }, delay);
    }
  }
  class Geocoder {
    getAddress(_point, callback) {
      callback("complete", {
        regeocode: { formattedAddress: "SDK mock 公共入口地址" },
      });
    }
  }
  window.AMap = {
    Map,
    Marker: Overlay,
    Circle: Overlay,
    PlaceSearch,
    Geocoder,
    convertFrom(point, type, callback) {
      document.body.dataset.convertInput = `${point.join(",")}:${type}`;
      callback("complete", { locations: [lnglat(120.208, 30.214)] });
    },
  };
})();
