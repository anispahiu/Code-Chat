(() => {
  const key = 'code-chat-theme';
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="color-scheme"]');

  function applyTheme(preference) {
    const theme = preference === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    meta.content = theme;
  }

  try {
    applyTheme(localStorage.getItem(key));
  } catch {
    // Storage may be disabled. The theme can still change for this page.
  }

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    function updateLabel() {
      toggle.textContent = root.dataset.theme === 'light' ? 'Dark mode' : 'Light mode';
    }

    updateLabel();
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light');
      updateLabel();
      try {
        localStorage.setItem(key, root.dataset.theme);
      } catch {
        // The current page already reflects the choice.
      }
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== key && event.key !== null) return;
      applyTheme(event.newValue);
      updateLabel();
    });
  });
})();
