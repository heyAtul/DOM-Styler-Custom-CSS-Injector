/*
 * devtools/devtools.js — registers a "Custom CSS Injector" pane in the Elements sidebar.
 *
 * This page is never visible. It runs once when DevTools opens on a tab, and the sidebar pane it
 * creates (sidebar.html) is where the actual work happens.
 */
chrome.devtools.panels.elements.createSidebarPane('Custom CSS Injector', (pane) => {
  pane.setPage('devtools/sidebar.html');
});
