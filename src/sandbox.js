// Sandbox page: allowed to run the inline scripts in upstream's generated HTML,
// but has no access to extension APIs. Replaces itself with the page it is sent.
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "render") return;
  document.open();
  document.write(event.data.html);
  document.close();
});
