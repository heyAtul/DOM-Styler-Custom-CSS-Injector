/*
 * devtools/devtools.js — registers a "DOM Styler" pane in the Elements sidebar.
 *
 * This page is never visible. It runs once when DevTools opens on a tab, and the sidebar pane it
 * creates (sidebar.html) is where the actual work happens.
 */
chrome.devtools.panels.elements.createSidebarPane('DOM Styler', (pane) => {
  pane.setPage('devtools/sidebar.html');
});
