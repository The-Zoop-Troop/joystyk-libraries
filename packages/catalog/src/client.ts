// The browser entry: importing the components is all hydration needs. Core restores the
// catalog store from the page's seed before <jy-app> hydrates.
import './components/app.ts';
import { provideDrivers } from '@gyral/core';
import { makeRouter } from '@gyral/router';

provideDrivers(document.documentElement, { router: makeRouter({ captureLinks: true }) });
