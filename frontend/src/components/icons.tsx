import type { SVGProps } from 'react';

const make = (d: React.ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>{d}</svg>
);

export const IInbox = make(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>);
export const IBox = make(<><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>);
export const IChart = make(<><path d="M3 3v18h18" /><path d="M7 16v-5" /><path d="M12 16V8" /><path d="M17 16v-9" /></>);
export const ISettings = make(<><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" /></>);
export const IStore = make(<><path d="M3 9 4.5 4h15L21 9" /><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z" /><path d="M5 13v8h14v-8" /><path d="M10 21v-5h4v5" /></>);
export const IBot = make(<><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4" /><circle cx="12" cy="3" r="1" /><path d="M9 13v1" /><path d="M15 13v1" /><path d="M2 14h2" /><path d="M20 14h2" /></>);
export const IUser = make(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const ISend = make(<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>);
export const IRefresh = make(<><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M3 21v-5h5" /></>);
export const IPlus = make(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const IX = make(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const ICheck = make(<path d="M20 6 9 17l-5-5" />);
export const IAlert = make(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);
export const ITruck = make(<><path d="M10 17h4V5H2v12h3" /><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1" /><circle cx="7.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>);
export const IExternal = make(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
export const IShield = make(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />);
export const IHand = make(<><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></>);
export const IChat = make(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const ITool = make(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />);
export const ISearch = make(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>);
export const IPanel = make(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>);
export const IBack = make(<path d="m15 18-6-6 6-6" />);
export const IPlay = make(<path d="m6 3 14 9-14 9V3z" />);
export const IFlag = make(<><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>);
