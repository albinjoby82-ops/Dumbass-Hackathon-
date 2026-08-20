(function (global) {
  'use strict';

  const DEFAULT_URL = 'data/facilities.json';

  function distanceKm(aLat, aLng, bLat, bLng) {
    const rad = value => value * Math.PI / 180;
    const earthKm = 6371;
    const dLat = rad(bLat - aLat);
    const dLng = rad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * earthKm * Math.asin(Math.sqrt(h));
  }

  function londonClock(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    const days = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { day: days[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function timeMinutes(value) {
    if (value === '24:00') return 1440;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }

  class FacilitiesDB {
    constructor(payload) {
      this.metadata = payload.metadata;
      this.facilities = payload.facilities;
      this.byId = new Map(this.facilities.map(facility => [facility.id, facility]));
    }

    static async load(url = DEFAULT_URL) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Facilities database failed to load (${response.status})`);
      return new FacilitiesDB(await response.json());
    }

    get(id) { return this.byId.get(id) || null; }

    isOpenAt(facilityOrId, date = new Date()) {
      const facility = typeof facilityOrId === 'string' ? this.get(facilityOrId) : facilityOrId;
      const urgent = facility && facility.urgentCare;
      if (!urgent || urgent.hoursStatus !== 'known' || !urgent.weekly.length) return null;
      const clock = londonClock(date);
      return urgent.weekly.some(period => period.days.includes(clock.day) &&
        clock.minutes >= timeMinutes(period.open) && clock.minutes < timeMinutes(period.close));
    }

    find({ service, urgentOnly = false, borough, query, openAt, walkInOnly = false, ageYears } = {}) {
      const needle = query && query.trim().toLowerCase();
      const serviceCode = service && service.toUpperCase();
      return this.facilities.filter(facility => {
        const serviceMatch = !serviceCode ||
          (serviceCode === 'URGENT' ? Boolean(facility.urgentCare) : facility.services.includes(serviceCode));
        const ageMatch = ageYears == null || !facility.urgentCare || facility.urgentCare.ageMinYears == null ||
          ageYears >= facility.urgentCare.ageMinYears;
        const openMatch = !openAt || this.isOpenAt(facility, openAt) === true;
        return serviceMatch &&
        (!urgentOnly || facility.urgentCare) &&
        (!walkInOnly || (facility.urgentCare && facility.urgentCare.walkIn)) &&
        ageMatch && openMatch &&
        (!borough || facility.borough.toLowerCase() === borough.toLowerCase()) &&
        (!needle || `${facility.name} ${facility.address} ${facility.postcode} ${facility.borough}`.toLowerCase().includes(needle));
      });
    }

    nearest(lat, lng, options = {}) {
      const limit = options.limit || 5;
      return this.find(options)
        .map(facility => ({ ...facility, distanceKm: distanceKm(lat, lng, facility.lat, facility.lng) }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);
    }
  }

  global.FacilitiesDB = FacilitiesDB;
})(window);
