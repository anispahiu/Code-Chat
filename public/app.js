const byId = (id) => document.getElementById(id);

async function api(path, body) {
  let response;
  try {
    response = await fetch('/api/' + path, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Couldn’t reach the app. Check your connection and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') location.replace('/login');
    throw Object.assign(new Error(result.error || 'The app could not complete the request.'), { status: response.status });
  }
  return result;
}

const login = byId('login');
if (login) {
  const error = byId('login-error');
  const submit = login.querySelector('button');
  const fallbackError = new URLSearchParams(location.search).get('error');
  if (fallbackError) {
    error.textContent = fallbackError === 'limit'
      ? 'Too many sign-in attempts. Try again in 15 minutes.'
      : 'Email or password is incorrect.';
  }

  login.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    error.textContent = '';
    try {
      await api('login', Object.fromEntries(new FormData(login)));
      location.replace('/');
    } catch (failure) {
      error.textContent = failure.message;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
} else {
  const { default: MarkdownIt } = await import('/markdown-it.js');
  const markdown = MarkdownIt('commonmark', { html: false, breaks: true })
    .disable(['image', 'link', 'autolink']);
  markdown.core.ruler.push('reply_headings', ({ tokens }) => {
    for (const token of tokens) {
      if (token.tag === 'h1' || token.tag === 'h2') token.tag = 'h3';
    }
  });
  chatApp(markdown);
}

function chatApp(markdown) {
  const title = byId('conversation-title');
  const welcome = byId('welcome');
  const messages = byId('messages');
  const feed = byId('feed');
  const composer = byId('composer');
  const question = byId('question');
  const send = byId('send');
  const status = byId('chat-status');
  const replyStatus = byId('reply-status');
  const retry = byId('retry');
  const sidebar = byId('sidebar');
  const toggle = byId('history-toggle');
  const historyList = byId('history-list');

  let current;
  let saved = [];

  function renderHistory() {
    const items = saved.map(({ id, title }) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '/?chat=' + id;
      link.dataset.conversation = id;
      link.textContent = title;
      link.title = title;
      if (id === current.id) link.setAttribute('aria-current', 'page');
      item.append(link);
      return item;
    });
    historyList.replaceChildren(...items);
    byId('history-empty').hidden = items.length > 0;
  }

  function renderControls(view, error = '', announcement = '') {
    const pending = view.busy || view.chat?.status === 'pending';
    const failed = view.chat?.status === 'unanswered';
    send.disabled = pending || view.loading || view.loadError;
    question.readOnly = view.busy;
    retry.hidden = pending || view.loading || (!failed && !view.loadError);
    retry.textContent = view.loadError ? 'Reload conversation' : 'Try again';
    status.textContent = error || announcement || (pending
      ? 'Looking through the application…'
      : failed ? 'Your question is saved. The assistant couldn’t answer.' : '');
    status.classList.toggle('error', Boolean(error) || (!pending && failed));
  }

  function renderMessages(view) {
    const chat = view.chat;
    welcome.hidden = Boolean(chat) || Boolean(view.id);
    messages.hidden = !chat;
    title.textContent = chat?.title || (view.id ? 'Conversation' : 'Codebase assistant');
    for (const { role, content } of chat?.messages.slice(messages.childElementCount) || []) {
      const item = document.createElement('li');
      item.className = 'message ' + role;
      const author = document.createElement('h2');
      author.textContent = role === 'user' ? 'You' : 'Assistant';
      const body = document.createElement('div');
      body.className = 'message-body';
      if (role === 'assistant') {
        // The renderer escapes embedded HTML and has no image or link rules.
        body.innerHTML = markdown.render(content);
      } else {
        body.textContent = content;
      }
      item.append(author, body);
      messages.append(item);
    }
  }

  async function refreshHistory() {
    const data = await api('chats');
    byId('account-email').textContent = data.email;
    byId('account-email').title = data.email;
    saved = data.chats;
    renderHistory();
  }

  function accept(view, chat, follow = false) {
    const previous = view.chat;
    view.chat = chat;
    view.loading = false;
    if (view !== current) return;
    if (!previous || previous.messages.length !== chat.messages.length) {
      const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
      renderMessages(view);
      if (!previous || follow || nearBottom) {
        const block = chat.messages.at(-1)?.role === 'assistant' ? 'start' : 'end';
        messages.lastElementChild?.scrollIntoView({ block });
      }
    }
    renderControls(view);
    if (previous?.status === 'pending' && chat.status === 'ready') {
      replyStatus.textContent = 'Answer ready.';
    }
    if (chat.status === 'pending') scheduleRefresh(view);
  }

  function scheduleRefresh(view) {
    clearTimeout(view.timer);
    view.timer = setTimeout(async () => {
      if (view !== current) return;
      try {
        accept(view, await api('chats/' + view.id));
      } catch {
        if (view !== current) return;
        renderControls(view, '', 'Connection interrupted. Reconnecting…');
        scheduleRefresh(view);
      }
    }, 1200);
  }

  async function loadConversation(view) {
    view.loading = true;
    view.loadError = false;
    renderControls(view, '', 'Loading conversation…');
    try {
      const chat = await api('chats/' + view.id);
      if (!Array.isArray(chat?.messages)) throw new Error('The app returned an unreadable conversation.');
      accept(view, chat);
    } catch (error) {
      if (view !== current) return;
      view.loading = false;
      view.loadError = true;
      renderControls(view, error.message);
    }
  }

  function select(id, focus = false) {
    clearTimeout(current?.timer);
    const view = { id };
    current = view;
    question.value = '';
    replyStatus.textContent = '';
    messages.replaceChildren();
    renderMessages(view);
    renderHistory();
    if (focus) title.focus();

    if (id) loadConversation(view);
    else renderControls(view);
  }

  function setHistoryOpen(open) {
    sidebar.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'false';
    setHistoryOpen(open);
    if (open) sidebar.querySelector('.new-chat').focus();
  });
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setHistoryOpen(false);
      toggle.focus();
    }
  });
  sidebar.addEventListener('click', (event) => {
    const link = event.target.closest('[data-conversation]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const id = link.dataset.conversation || null;
    if (current.id !== id) history.pushState(null, '', link.href);
    setHistoryOpen(false);
    select(id, true);
  });
  const fromUrl = () => new URLSearchParams(location.search).get('chat');
  window.addEventListener('popstate', () => select(fromUrl()));
  select(fromUrl());
  refreshHistory().catch(() => {
    byId('history-empty').textContent = 'Couldn’t load conversations. Refresh to try again.';
    byId('history-empty').hidden = false;
  });

  welcome.querySelectorAll('.suggestions button').forEach((button) => {
    button.addEventListener('click', () => {
      question.value = button.textContent;
      question.focus();
    });
  });
  question.addEventListener('input', () => question.setCustomValidity(''));
  question.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!send.disabled) composer.requestSubmit();
  });

  async function submit(view, payload, isRetry = false) {
    view.busy = true;
    replyStatus.textContent = '';
    renderControls(view);
    try {
      const path = 'chats/' + view.id + (isRetry ? '/retry' : '');
      const chat = await api(path, payload);
      view.busy = false;
      view.attempt = null;
      if (view === current) {
        if (!isRetry) {
          question.value = '';
          const url = '/?chat=' + chat.id;
          if (view.fresh) history.pushState(null, '', url);
          view.fresh = false;
        }
        accept(view, chat, true);
      }
      saved = [{ id: chat.id, title: chat.title }, ...saved.filter(({ id }) => id !== chat.id)];
      renderHistory();
    } catch (error) {
      view.busy = false;
      if (view !== current) return;
      renderControls(view, error.message);
      if (error.status === 409) {
        api('chats/' + view.id).then((chat) => accept(view, chat)).catch(() => {});
      }
    }
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (send.disabled) return;
    const message = question.value.trim();
    if (!message) {
      question.setCustomValidity('Enter a question.');
      question.reportValidity();
      return;
    }
    if (!current.id) {
      current.id = crypto.randomUUID();
      current.fresh = true;
    }
    if (current.attempt?.message !== message) {
      current.attempt = { requestId: crypto.randomUUID(), message };
    }
    submit(current, current.attempt);
  });
  retry.addEventListener('click', () => {
    if (current.loadError) {
      title.focus();
      loadConversation(current);
      return;
    }
    submit(current, { messageId: current.chat.messages.at(-1).id }, true);
    question.focus();
  });
}
