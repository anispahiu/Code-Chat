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
      const result = await api('login', Object.fromEntries(new FormData(login)));
      location.replace(result.role === 'admin' ? '/admin' : '/');
    } catch (failure) {
      error.textContent = failure.message;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
} else {
  const { createMarkdownRenderer } = await import('/markdown.js');
  chatApp(createMarkdownRenderer());
}

function createFolderIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('folder-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z');
  svg.append(path);
  return svg;
}

function chatApp(markdown) {
  const workspace = byId('workspace');
  const sidebar = byId('sidebar');
  const sidebarToggle = byId('sidebar-toggle');
  const newChatLink = byId('new-chat');
  const projectsTree = byId('projects-tree');
  const projectsEmpty = byId('projects-empty');
  const title = byId('conversation-title');
  const projectStateBadge = byId('project-state-badge');
  const welcome = byId('welcome');
  const welcomeTitle = byId('welcome-title');
  const welcomeDescription = byId('welcome-description');
  const suggestions = byId('suggestions');
  const messages = byId('messages');
  const feed = byId('feed');
  const composer = byId('composer');
  const question = byId('question');
  const send = byId('send');
  const status = byId('chat-status');
  const replyStatus = byId('reply-status');
  const retry = byId('retry');

  const mobileQuery = window.matchMedia('(max-width: 46rem)');
  let projects = [];
  let allChats = [];
  let selectedProjectId = null;
  let current = { id: null };
  const collapsedProjects = new Set();

  function selectedProject() {
    return projects.find((project) => project.id === selectedProjectId) || null;
  }

  function buildUrl(projectId, chatId = null) {
    const params = new URLSearchParams();
    if (projectId) params.set('project', String(projectId));
    if (chatId) params.set('chat', chatId);
    const qs = params.toString();
    return qs ? '/?' + qs : '/';
  }

  function readUrlState() {
    const params = new URLSearchParams(location.search);
    const rawProject = params.get('project');
    const projectId = rawProject && /^[1-9]\d*$/.test(rawProject) ? Number(rawProject) : null;
    const chatId = params.get('chat') || null;
    return { projectId, chatId };
  }

  function setSidebarOpen(open) {
    if (mobileQuery.matches) {
      sidebar.classList.toggle('open', open);
      workspace.classList.remove('sidebar-collapsed');
    } else {
      sidebar.classList.remove('open');
      workspace.classList.toggle('sidebar-collapsed', !open);
    }
    sidebarToggle.setAttribute('aria-expanded', String(open));
  }

  setSidebarOpen(!mobileQuery.matches);
  mobileQuery.addEventListener('change', (event) => setSidebarOpen(!event.matches));

  sidebarToggle.addEventListener('click', () => {
    const currentlyOpen = sidebarToggle.getAttribute('aria-expanded') === 'true';
    setSidebarOpen(!currentlyOpen);
    if (!currentlyOpen && mobileQuery.matches) {
      const firstFocusable = sidebar.querySelector('.project-folder, .new-chat');
      firstFocusable?.focus();
    }
  });

  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobileQuery.matches && sidebar.classList.contains('open')) {
      setSidebarOpen(false);
      sidebarToggle.focus();
    }
  });

  function renderProjectState() {
    const project = selectedProject();
    newChatLink.href = buildUrl(project?.id ?? null);
    newChatLink.setAttribute('aria-disabled', String(!project || !project.indexed || project.indexing));

    if (!project) {
      projectStateBadge.hidden = true;
      welcomeTitle.textContent = projects.length === 0 ? 'No projects assigned yet' : 'Select a project';
      welcomeDescription.textContent = projects.length === 0
        ? 'Your administrator has not assigned any projects to your account yet.'
        : 'Choose an assigned project from the sidebar to start asking questions.';
      suggestions.hidden = true;
      return;
    }

    welcomeTitle.textContent = project.name;
    welcomeDescription.textContent = project.description
      || 'Ask how this application works, from everyday tasks to the rules behind them.';

    if (project.indexing) {
      projectStateBadge.textContent = 'Indexing…';
      projectStateBadge.className = 'badge badge-accent';
      projectStateBadge.hidden = false;
      suggestions.hidden = true;
    } else if (!project.indexed) {
      projectStateBadge.textContent = 'Not indexed';
      projectStateBadge.className = 'badge badge-danger';
      projectStateBadge.hidden = false;
      suggestions.hidden = true;
    } else {
      projectStateBadge.hidden = true;
      suggestions.hidden = false;
    }
  }

  function renderProjectsTree() {
    const byProject = new Map();
    for (const chat of allChats) {
      const list = byProject.get(chat.projectId) || [];
      list.push(chat);
      byProject.set(chat.projectId, list);
    }

    const groups = projects.map((project) => {
      const groupLi = document.createElement('li');
      groupLi.className = 'project-group';
      const isSelected = project.id === selectedProjectId;
      const isCollapsed = collapsedProjects.has(project.id);

      const headerRow = document.createElement('div');
      headerRow.className = 'project-row' + (isSelected && !current.id ? ' active' : '');

      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'project-folder';
      folderBtn.dataset.projectId = String(project.id);
      folderBtn.setAttribute('aria-expanded', String(!isCollapsed));
      folderBtn.title = project.name;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'project-folder-name';
      labelSpan.textContent = project.name;

      folderBtn.append(createFolderIcon(), labelSpan);

      if (project.indexing || !project.indexed) {
        const dot = document.createElement('span');
        dot.className = 'project-status-pill';
        dot.textContent = project.indexing ? 'indexing' : 'unindexed';
        folderBtn.append(dot);
      }

      headerRow.append(folderBtn);
      groupLi.append(headerRow);

      const chats = byProject.get(project.id) || [];
      if (chats.length > 0 && !isCollapsed) {
        const ul = document.createElement('ul');
        ul.className = 'project-chats';
        for (const chat of chats) {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = buildUrl(project.id, chat.id);
          link.dataset.conversation = chat.id;
          link.dataset.projectId = String(project.id);
          link.textContent = chat.title;
          link.title = chat.title;
          if (chat.id === current.id) link.setAttribute('aria-current', 'page');
          item.append(link);
          ul.append(item);
        }
        groupLi.append(ul);
      }

      return groupLi;
    });

    projectsTree.replaceChildren(...groups);
    projectsEmpty.hidden = groups.length > 0;
  }

  function renderControls(view, error = '', announcement = '') {
    const project = selectedProject();
    const unavailableReason = !project
      ? 'No assigned project is available.'
      : project.indexing
        ? 'This project index is currently updating. Try again shortly.'
        : !project.indexed
          ? 'This project is not indexed yet. Ask your administrator to initialize CodeGraph.'
          : '';
    const blocked = Boolean(unavailableReason);
    const pending = view.busy || view.chat?.status === 'pending';
    const failed = view.chat?.status === 'unanswered';
    send.disabled = blocked || pending || view.loading || view.loadError;
    question.disabled = blocked;
    question.readOnly = view.busy;
    retry.hidden = pending || view.loading || (!failed && !view.loadError) || (failed && blocked);
    retry.textContent = view.loadError ? 'Reload conversation' : 'Try again';
    status.textContent = error || announcement || (pending
      ? 'Looking through the application…'
      : failed ? 'Your question is saved. The assistant couldn’t answer.' : unavailableReason);
    status.classList.toggle('error', Boolean(error) || (!pending && (failed || (blocked && Boolean(project) && !project.indexing))));
  }

  function renderMessages(view) {
    const chat = view.chat;
    const project = selectedProject();
    welcome.hidden = Boolean(chat) || Boolean(view.id);
    messages.hidden = !chat;
    title.textContent = chat?.title || (view.id ? 'Conversation' : (project?.name || 'Code Chat'));
    for (const { role, content } of chat?.messages.slice(messages.childElementCount) || []) {
      const item = document.createElement('li');
      item.className = 'message ' + role;
      const author = document.createElement('h2');
      author.textContent = role === 'user' ? 'You' : 'Assistant';
      const body = document.createElement('div');
      body.className = 'message-body';
      if (role === 'assistant') {
        body.innerHTML = markdown.render(content);
      } else {
        body.textContent = content;
      }
      item.append(author, body);
      messages.append(item);
    }
  }

  async function refreshAllChats() {
    const data = await api('chats');
    allChats = Array.isArray(data.chats) ? data.chats : [];
    renderProjectsTree();
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
      } catch (error) {
        if (view !== current) return;
        if (error.status === 404 || error.status === 403) {
          renderControls(view, error.message);
          return;
        }
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
      if (chat.projectId && chat.projectId !== selectedProjectId && projects.some((p) => p.id === chat.projectId)) {
        selectedProjectId = chat.projectId;
        collapsedProjects.delete(chat.projectId);
        renderProjectState();
        renderProjectsTree();
      }
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
    renderProjectState();
    renderMessages(view);
    renderProjectsTree();
    if (focus) title.focus();

    if (id) loadConversation(view);
    else renderControls(view);
  }

  function openProjectChat(projectId, chatId = null, push = true, focus = false) {
    selectedProjectId = projectId;
    if (projectId) collapsedProjects.delete(projectId);
    if (push) history.pushState(null, '', buildUrl(projectId, chatId));
    select(chatId, focus);
  }

  sidebar.addEventListener('click', (event) => {
    const newChatBtn = event.target.closest('[data-new-chat]');
    if (newChatBtn && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (newChatBtn.getAttribute('aria-disabled') === 'true' || !selectedProjectId) return;
      if (mobileQuery.matches) setSidebarOpen(false);
      openProjectChat(selectedProjectId, null, current.id !== null, true);
      return;
    }

    const folderBtn = event.target.closest('.project-folder');
    if (folderBtn) {
      const projectId = Number(folderBtn.dataset.projectId);
      if (!projectId) return;
      if (selectedProjectId === projectId && !current.id) {
        if (collapsedProjects.has(projectId)) collapsedProjects.delete(projectId);
        else collapsedProjects.add(projectId);
        renderProjectsTree();
      } else {
        if (mobileQuery.matches) setSidebarOpen(false);
        openProjectChat(projectId, null, true, true);
      }
      return;
    }

    const link = event.target.closest('[data-conversation]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const id = link.dataset.conversation || null;
    const projectId = Number(link.dataset.projectId) || selectedProjectId;
    if (mobileQuery.matches) setSidebarOpen(false);
    openProjectChat(projectId, id, current.id !== id || selectedProjectId !== projectId, true);
  });

  window.addEventListener('popstate', () => {
    const state = readUrlState();
    const targetProject = projects.some((p) => p.id === state.projectId)
      ? state.projectId
      : (projects[0]?.id ?? null);
    openProjectChat(targetProject, state.chatId, false, false);
  });

  welcome.querySelectorAll('.suggestions button').forEach((button) => {
    button.addEventListener('click', () => {
      if (question.disabled) return;
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
          const url = buildUrl(chat.projectId, chat.id);
          if (view.fresh) history.pushState(null, '', url);
          view.fresh = false;
        }
        accept(view, chat, true);
      }
      allChats = [{ id: chat.id, projectId: chat.projectId, title: chat.title }, ...allChats.filter(({ id }) => id !== chat.id)];
      collapsedProjects.delete(chat.projectId);
      renderProjectsTree();
    } catch (error) {
      view.busy = false;
      if (view !== current) return;
      renderControls(view, error.message);
      if (error.status === 409 && !isRetry && view.chat) {
        api('chats/' + view.id).then((chat) => accept(view, chat)).catch(() => {});
      }
    }
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (send.disabled || !selectedProjectId) return;
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
    if (current.attempt?.message !== message || current.attempt?.projectId !== selectedProjectId) {
      current.attempt = {
        projectId: selectedProjectId,
        requestId: crypto.randomUUID(),
        message,
      };
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

  async function bootstrap() {
    try {
      const me = await api('me');
      if (me.role === 'admin') {
        location.replace('/admin');
        return;
      }
      const nameEl = byId('account-name');
      const emailEl = byId('account-email');
      nameEl.textContent = me.name || me.email;
      nameEl.title = me.name || me.email;
      emailEl.textContent = me.name ? me.email : '';
      emailEl.title = me.email;
      emailEl.hidden = !me.name;

      const [projectData, chatData] = await Promise.all([api('projects'), api('chats')]);
      projects = projectData.projects || [];
      allChats = Array.isArray(chatData.chats) ? chatData.chats : [];

      const urlState = readUrlState();
      const chatFromUrl = urlState.chatId ? allChats.find((c) => c.id === urlState.chatId) : null;
      const initialProject = chatFromUrl && projects.some((p) => p.id === chatFromUrl.projectId)
        ? chatFromUrl.projectId
        : projects.some((p) => p.id === urlState.projectId)
          ? urlState.projectId
          : (projects[0]?.id ?? null);

      selectedProjectId = initialProject;
      if (initialProject && urlState.projectId !== initialProject) {
        history.replaceState(null, '', buildUrl(initialProject, urlState.chatId));
      }
      select(initialProject ? urlState.chatId : null, false);
    } catch (error) {
      renderControls(current, error.message);
    }
  }

  bootstrap();
}
