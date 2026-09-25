/** Линейные иконки 24×24 (stroke), в стиле Lucide. */

const P = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  map: '<path d="m9 4-6 2.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".5"/><circle cx="3.5" cy="12" r=".5"/><circle cx="3.5" cy="18" r=".5"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  go: '<path d="M4.5 11.2 20 4l-7.2 15.5-2-6.3z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  offline: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.8 5M5 12.6a10 10 0 0 1 3.6-2.3M19 12.6a10 10 0 0 0-2.1-1.6M8.5 16.4a5 5 0 0 1 5.4-1M12 20h.01M3 3l18 18"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/>',
  mountain: '<path d="m3 20 6.5-11 4 6.5 2.5-4L21 20z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  box: '<path d="M21 8v12H3V8"/><path d="M1.5 4h21v4h-21z"/><path d="M10 12h4"/>',
  share: '<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/>',
  plusSquare: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10v4"/>',
  satellite: '<path d="m13 7 4-4 4 4-4 4zM3 17l4-4 4 4-4 4z"/><path d="m9 11 4 4M14.5 9.5 9.5 14.5"/><path d="M16 21a5 5 0 0 0 5-5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bike: '<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 9 9.5h6.5L18.5 17M9 9.5 12 17l3.5-7.5M8 6h3M15.5 9.5 14.5 6H17"/>',
};

export function icon(name, { size = 24, cls = "" } = {}) {
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}
