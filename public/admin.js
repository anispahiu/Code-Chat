import { createMarkdownRenderer } from '/markdown.js';

const byId = (id) => document.getElementById(id);
const markdown = createMarkdownRenderer();

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch('/api/' + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Couldn’t reach the app. Check your connection and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) location.replace('/login');
    throw Object.assign(new Error(result.error || 'The app could not complete the request.'), { status: response.status });
  }
  return result;
}

const notice = byId('admin-notice');
function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
}

let me = null;
let users = [];
let projects = [];
const projectStatuses = new Map();
const pollTimers = new Map();
let pendingDeleteProject = null;

function activateTab(name) {
  document.querySelectorAll('.tab-button').forEach((button) => {
    const active = button.dataset.tab === name;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.admin-panel').forEach((panel) => {
    panel.hidden = panel.id !== 'tab-' + name;
  });
  if (name === 'projects') refreshProjects().catch((error) => showNotice(error.message, true));
  if (name === 'history') refreshHistoryPanel().catch((error) => showNotice(error.message, true));
}

document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    showNotice('');
    activateTab(button.dataset.tab);
  });
});

const passwordBanner = byId('password-banner');
const passwordTitle = byId('password-banner-title');
const passwordValue = byId('password-value');

function showOneTimePassword(label, email, password) {
  passwordTitle.textContent = `${label} for ${email}`;
  passwordValue.textContent = password;
  passwordBanner.hidden = false;
}

byId('copy-password').addEventListener('click', async () => {
  const value = passwordValue.textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showNotice('Password copied to clipboard.');
  } catch {
    showNotice('Copy failed. Select and copy the password manually.', true);
  }
});

byId('dismiss-password').addEventListener('click', () => {
  passwordValue.textContent = '';
  passwordBanner.hidden = true;
});

const editUserForm = byId('edit-user-form');
const assignProjectsForm = byId('assign-projects-form');

function openEditUser(user) {
  byId('edit-user-id').value = String(user.id);
  byId('edit-user-name').value = user.name || '';
  byId('edit-user-email').value = user.email;
  byId('edit-user-heading').textContent = `Edit ${user.email}`;
  assignProjectsForm.hidden = true;
  editUserForm.hidden = false;
  byId('edit-user-name').focus();
}

byId('cancel-edit-user').addEventListener('click', () => {
  editUserForm.hidden = true;
});

async function openAssignProjects(user) {
  showNotice('');
  try {
    if (!projects.length) await refreshProjects();
    const { projectIds } = await api(`admin/users/${user.id}/projects`);
    const assigned = new Set(projectIds);
    byId('assign-user-id').value = String(user.id);
    byId('assign-projects-heading').textContent = `Projects for ${user.name || user.email}`;
    const list = byId('assign-projects-list');
    const items = projects.map((project) => {
      const label = document.createElement('label');
      label.className = 'checkbox-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'projectId';
      input.value = String(project.id);
      input.checked = assigned.has(project.id);
      const span = document.createElement('span');
      span.textContent = project.name;
      label.append(input, span);
      return label;
    });
    list.replaceChildren(...items);
    byId('assign-projects-empty').hidden = items.length > 0;
    byId('save-assignments').hidden = items.length === 0;
    editUserForm.hidden = true;
    assignProjectsForm.hidden = false;
  } catch (error) {
    showNotice(error.message, true);
  }
}

byId('cancel-assignments').addEventListener('click', () => {
  assignProjectsForm.hidden = true;
});

assignProjectsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const userId = byId('assign-user-id').value;
  const projectIds = [...assignProjectsForm.querySelectorAll('input[name="projectId"]:checked')]
    .map((input) => Number(input.value));
  const submit = byId('save-assignments');
  submit.disabled = true;
  showNotice('');
  try {
    await api(`admin/users/${userId}/projects`, { method: 'PUT', body: { projectIds } });
    assignProjectsForm.hidden = true;
    showNotice('Saved project assignments.');
    await Promise.all([refreshUsers(), refreshProjects()]);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

function renderUsers() {
  const tbody = byId('users-tbody');
  const rows = users.map((user) => {
    const tr = document.createElement('tr');

    const accountTd = document.createElement('td');
    const primary = document.createElement('div');
    primary.className = 'cell-primary';
    primary.textContent = user.name || user.email;
    accountTd.append(primary);
    if (user.name) {
      const sub = document.createElement('div');
      sub.className = 'cell-secondary';
      sub.textContent = user.email;
      accountTd.append(sub);
    }

    const roleTd = document.createElement('td');
    const roleBadge = document.createElement('span');
    roleBadge.className = 'badge' + (user.role === 'admin' ? ' badge-accent' : '');
    roleBadge.textContent = user.role;
    roleTd.append(roleBadge);

    const statusTd = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge' + (user.disabled ? ' badge-danger' : ' badge-ok');
    statusBadge.textContent = user.disabled ? 'Disabled' : 'Active';
    statusTd.append(statusBadge);

    const projectsTd = document.createElement('td');
    if (user.role === 'admin') {
      const dash = document.createElement('span');
      dash.className = 'cell-secondary';
      dash.textContent = 'Admin (no chat)';
      projectsTd.append(dash);
    } else {
      const count = Array.isArray(user.projectIds) ? user.projectIds.length : 0;
      projectsTd.textContent = `${count} assigned`;
    }

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    if (user.role === 'client') {
      const assignBtn = document.createElement('button');
      assignBtn.type = 'button';
      assignBtn.className = 'outline compact';
      assignBtn.textContent = 'Projects';
      assignBtn.addEventListener('click', () => openAssignProjects(user));
      actionsTd.append(assignBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'outline compact';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditUser(user));

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'outline compact';
    resetBtn.textContent = 'Reset password';
    resetBtn.addEventListener('click', async () => {
      if (!confirm(`Reset password for ${user.email}? This will sign them out immediately.`)) return;
      resetBtn.disabled = true;
      showNotice('');
      try {
        const res = await api(`admin/users/${user.id}/reset-password`, { method: 'POST', body: {} });
        showOneTimePassword('New password', res.user.email, res.password);
        showNotice(`Password reset for ${res.user.email}.`);
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        resetBtn.disabled = false;
      }
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'outline compact';
    toggleBtn.textContent = user.disabled ? 'Enable' : 'Disable';
    if (me && user.id === me.id && !user.disabled) {
      toggleBtn.disabled = true;
      toggleBtn.title = 'You cannot disable your own account.';
    }
    toggleBtn.addEventListener('click', async () => {
      toggleBtn.disabled = true;
      showNotice('');
      try {
        const res = await api(`admin/users/${user.id}`, {
          method: 'PATCH',
          body: { disabled: !user.disabled },
        });
        showNotice(res.user.disabled ? `Disabled ${res.user.email}.` : `Enabled ${res.user.email}.`);
        await refreshUsers();
      } catch (error) {
        showNotice(error.message, true);
        toggleBtn.disabled = false;
      }
    });

    actionsTd.append(editBtn, resetBtn, toggleBtn);
    tr.append(accountTd, roleTd, statusTd, projectsTd, actionsTd);
    return tr;
  });

  tbody.replaceChildren(...rows);
  byId('users-empty').hidden = rows.length > 0;
}

async function refreshUsers() {
  const data = await api('admin/users');
  users = data.users;
  renderUsers();
}

const createForm = byId('create-user-form');
createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = byId('create-user-submit');
  submit.disabled = true;
  showNotice('');
  try {
    const formData = Object.fromEntries(new FormData(createForm));
    const res = await api('admin/users', { method: 'POST', body: formData });
    createForm.reset();
    showOneTimePassword('Account password', res.user.email, res.password);
    showNotice(`Created ${res.user.role} account for ${res.user.email}.`);
    await refreshUsers();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

editUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showNotice('');
  try {
    const id = byId('edit-user-id').value;
    const body = {
      name: byId('edit-user-name').value,
      email: byId('edit-user-email').value,
    };
    const res = await api(`admin/users/${id}`, { method: 'PATCH', body });
    editUserForm.hidden = true;
    showNotice(`Updated ${res.user.email}.`);
    await refreshUsers();
  } catch (error) {
    showNotice(error.message, true);
  }
});

const editProjectForm = byId('edit-project-form');
const deleteProjectPanel = byId('delete-project-panel');

function openEditProject(project) {
  byId('edit-project-id').value = String(project.id);
  byId('edit-project-name').value = project.name;
  byId('edit-project-path').value = project.relativePath;
  byId('edit-project-desc').value = project.description || '';
  byId('edit-project-heading').textContent = `Edit ${project.name}`;
  editProjectForm.hidden = false;
  deleteProjectPanel.hidden = true;
  byId('edit-project-name').focus();
}

byId('cancel-edit-project').addEventListener('click', () => {
  editProjectForm.hidden = true;
});

function openDeleteProject(project) {
  pendingDeleteProject = project;
  byId('delete-project-heading').textContent = `Delete "${project.name}"?`;
  byId('delete-project-summary').textContent = project.chatCount > 0
    ? `This project has ${project.chatCount} saved conversation(s). Leaving the box unchecked keeps the conversation history in Admin History.`
    : 'This project has no saved conversations and will be removed.';
  byId('delete-project-chats').checked = false;
  deleteProjectPanel.hidden = false;
  editProjectForm.hidden = true;
}

byId('cancel-delete-project').addEventListener('click', () => {
  pendingDeleteProject = null;
  deleteProjectPanel.hidden = true;
});

byId('confirm-delete-project').addEventListener('click', async () => {
  if (!pendingDeleteProject) return;
  const project = pendingDeleteProject;
  const deleteChats = byId('delete-project-chats').checked;
  const btn = byId('confirm-delete-project');
  btn.disabled = true;
  showNotice('');
  try {
    const res = await api(`admin/projects/${project.id}`, {
      method: 'DELETE',
      body: { deleteChats },
    });
    pendingDeleteProject = null;
    deleteProjectPanel.hidden = true;
    showNotice(res.deletedChats
      ? `Deleted "${project.name}" and its conversation history.`
      : res.retainedHistory
        ? `Deleted "${project.name}". Conversation history was retained in Admin History.`
        : `Deleted "${project.name}".`);
    await refreshProjects();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    btn.disabled = false;
  }
});

function scheduleJobPoll(projectId) {
  clearTimeout(pollTimers.get(projectId));
  const timer = setTimeout(async () => {
    try {
      const { job } = await api(`admin/projects/${projectId}/job`);
      const target = projects.find((item) => item.id === projectId);
      if (target) target.job = job;
      if (job.state === 'running') {
        renderProjects();
        scheduleJobPoll(projectId);
      } else {
        await checkProjectStatus(projectId, false);
        renderProjects();
      }
    } catch {
      pollTimers.delete(projectId);
    }
  }, 1500);
  pollTimers.set(projectId, timer);
}

async function checkProjectStatus(projectId, rerender = true) {
  const statusData = await api(`admin/projects/${projectId}/status`);
  projectStatuses.set(projectId, statusData);
  const target = projects.find((item) => item.id === projectId);
  if (target && statusData.job) target.job = statusData.job;
  if (rerender) renderProjects();
}

function renderProjects() {
  const list = byId('projects-list');
  const cards = projects.map((project) => {
    const card = document.createElement('article');
    card.className = 'card project-card';

    const top = document.createElement('div');
    top.className = 'project-card-head';

    const meta = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = project.name;
    const pathLine = document.createElement('p');
    pathLine.className = 'cell-secondary';
    const pathCode = document.createElement('code');
    pathCode.textContent = project.relativePath;
    pathLine.append('Path: ', pathCode);
    meta.append(title, pathLine);
    if (project.description) {
      const desc = document.createElement('p');
      desc.className = 'panel-subtitle';
      desc.textContent = project.description;
      meta.append(desc);
    }

    const statusObj = projectStatuses.get(project.id);
    const job = project.job;
    const badges = document.createElement('div');
    badges.className = 'project-badges';

    const stateBadge = document.createElement('span');
    if (job?.state === 'running') {
      stateBadge.className = 'badge badge-accent';
      stateBadge.textContent = `Running ${job.action}…`;
    } else if (statusObj) {
      if (statusObj.ready) {
        stateBadge.className = 'badge badge-ok';
        stateBadge.textContent = `Indexed (${statusObj.fileCount} files, ${statusObj.nodeCount} symbols)`;
      } else if (!statusObj.pathExists) {
        stateBadge.className = 'badge badge-danger';
        stateBadge.textContent = 'Path missing';
      } else if (statusObj.error) {
        stateBadge.className = 'badge badge-danger';
        stateBadge.textContent = 'Status error';
      } else {
        stateBadge.className = 'badge';
        stateBadge.textContent = 'Not initialized';
      }
    } else {
      stateBadge.className = 'badge';
      stateBadge.textContent = 'Status unchecked';
    }
    badges.append(stateBadge);

    const countsBadge = document.createElement('span');
    countsBadge.className = 'badge';
    countsBadge.textContent = `${project.assignedCount} client(s) · ${project.chatCount} chat(s)`;
    badges.append(countsBadge);

    top.append(meta, badges);
    card.append(top);

    if (statusObj?.lastIndexed) {
      const detail = document.createElement('p');
      detail.className = 'cell-secondary';
      const pending = statusObj.pendingChanges
        ? statusObj.pendingChanges.added + statusObj.pendingChanges.modified + statusObj.pendingChanges.removed
        : 0;
      detail.textContent = `Last indexed: ${new Date(statusObj.lastIndexed).toLocaleString()}` +
        (pending > 0 ? ` · ${pending} pending file change(s)` : '');
      card.append(detail);
    }
    if (statusObj?.error) {
      const errLine = document.createElement('p');
      errLine.className = 'notice error';
      errLine.textContent = statusObj.error;
      card.append(errLine);
    }

    const actions = document.createElement('div');
    actions.className = 'actions-cell';
    const busy = job?.state === 'running';

    const statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.className = 'outline compact';
    statusBtn.textContent = 'Check status';
    statusBtn.addEventListener('click', async () => {
      statusBtn.disabled = true;
      showNotice('');
      try {
        await checkProjectStatus(project.id);
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        statusBtn.disabled = false;
      }
    });

    const initBtn = document.createElement('button');
    initBtn.type = 'button';
    initBtn.className = 'outline compact';
    initBtn.textContent = 'Initialize';
    initBtn.disabled = busy;
    initBtn.addEventListener('click', async () => {
      initBtn.disabled = true;
      showNotice('');
      try {
        const res = await api(`admin/projects/${project.id}/init`, { method: 'POST', body: {} });
        project.job = res.job;
        renderProjects();
        scheduleJobPoll(project.id);
      } catch (error) {
        showNotice(error.message, true);
        initBtn.disabled = false;
      }
    });

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'outline compact';
    syncBtn.textContent = 'Sync';
    syncBtn.disabled = busy;
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      showNotice('');
      try {
        const res = await api(`admin/projects/${project.id}/sync`, { method: 'POST', body: {} });
        project.job = res.job;
        renderProjects();
        scheduleJobPoll(project.id);
      } catch (error) {
        showNotice(error.message, true);
        syncBtn.disabled = false;
      }
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'outline compact';
    editBtn.textContent = 'Edit';
    editBtn.disabled = busy;
    editBtn.addEventListener('click', () => openEditProject(project));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'outline compact';
    deleteBtn.textContent = 'Delete';
    deleteBtn.disabled = busy;
    deleteBtn.addEventListener('click', () => openDeleteProject(project));

    actions.append(statusBtn, initBtn, syncBtn, editBtn, deleteBtn);
    card.append(actions);

    if (job && job.state !== 'idle') {
      const jobBox = document.createElement('div');
      jobBox.className = 'job-log';
      const summary = document.createElement('p');
      summary.className = 'notice' + (job.state === 'failed' ? ' error' : '');
      summary.textContent = job.state === 'running'
        ? `Running codegraph ${job.action}…`
        : job.state === 'succeeded'
          ? `Last ${job.action} succeeded (${new Date(job.finishedAt).toLocaleTimeString()}).`
          : job.error || `Last ${job.action} failed.`;
      jobBox.append(summary);
      if (job.output) {
        const pre = document.createElement('pre');
        pre.textContent = job.output;
        jobBox.append(pre);
      }
      card.append(jobBox);
    }

    return card;
  });

  list.replaceChildren(...cards);
  byId('projects-empty').hidden = cards.length > 0;
}

async function refreshProjects() {
  const data = await api('admin/projects');
  projects = data.projects;
  renderProjects();
  for (const project of projects) {
    if (project.job?.state === 'running') {
      scheduleJobPoll(project.id);
    }
  }
}

const createProjectForm = byId('create-project-form');
createProjectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = byId('create-project-submit');
  submit.disabled = true;
  showNotice('');
  try {
    const formData = Object.fromEntries(new FormData(createProjectForm));
    const res = await api('admin/projects', { method: 'POST', body: formData });
    createProjectForm.reset();
    showNotice(`Added project "${res.project.name}".`);
    await refreshProjects();
    await checkProjectStatus(res.project.id);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

editProjectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showNotice('');
  try {
    const id = byId('edit-project-id').value;
    const body = {
      name: byId('edit-project-name').value,
      relativePath: byId('edit-project-path').value,
      description: byId('edit-project-desc').value,
    };
    const res = await api(`admin/projects/${id}`, { method: 'PATCH', body });
    editProjectForm.hidden = true;
    showNotice(`Updated project "${res.project.name}".`);
    await refreshProjects();
  } catch (error) {
    showNotice(error.message, true);
  }
});

const historyUserFilter = byId('history-filter-user');
const historyProjectFilter = byId('history-filter-project');
let adminChats = [];
let selectedAdminChatId = null;

function populateHistoryFilters(historyProjects) {
  const prevUser = historyUserFilter.value;
  const userOptions = [
    Object.assign(document.createElement('option'), { value: '', textContent: 'All clients' }),
    ...users
      .filter((u) => u.role === 'client')
      .map((u) => {
        const opt = document.createElement('option');
        opt.value = String(u.id);
        opt.textContent = (u.name ? `${u.name} (${u.email})` : u.email) + (u.disabled ? ' [Disabled]' : '');
        if (opt.value === prevUser) opt.selected = true;
        return opt;
      }),
  ];
  historyUserFilter.replaceChildren(...userOptions);

  const prevProject = historyProjectFilter.value;
  const projOptions = [
    Object.assign(document.createElement('option'), { value: '', textContent: 'All projects' }),
    ...historyProjects.map((p) => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name + (p.deletedAt ? ' (Deleted)' : '');
      if (opt.value === prevProject) opt.selected = true;
      return opt;
    }),
  ];
  historyProjectFilter.replaceChildren(...projOptions);
}

function renderAdminChatsList() {
  const list = byId('admin-chats-list');
  const items = adminChats.map((chat) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-chat-item';
    if (chat.id === selectedAdminChatId) btn.setAttribute('aria-current', 'true');

    const titleEl = document.createElement('div');
    titleEl.className = 'cell-primary';
    titleEl.textContent = chat.title;

    const metaEl = document.createElement('div');
    metaEl.className = 'cell-secondary';
    const when = chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleString() : '';
    metaEl.textContent = `${chat.user.email} · ${chat.project.name}${chat.project.deletedAt ? ' (Deleted)' : ''} · ${chat.messageCount} msg(s)${when ? ' · ' + when : ''}`;

    btn.append(titleEl, metaEl);
    btn.addEventListener('click', () => loadAdminTranscript(chat.id));
    li.append(btn);
    return li;
  });
  list.replaceChildren(...items);
  byId('admin-chats-empty').hidden = items.length > 0;
}

async function loadAdminTranscript(chatId) {
  selectedAdminChatId = chatId;
  renderAdminChatsList();
  showNotice('');
  try {
    const chat = await api(`admin/chats/${chatId}`);
    byId('admin-transcript-placeholder').hidden = true;
    byId('admin-transcript-view').hidden = false;
    byId('admin-transcript-title').textContent = chat.title;

    const meta = byId('admin-transcript-meta');
    const badges = [];
    const clientBadge = document.createElement('span');
    clientBadge.className = 'badge';
    clientBadge.textContent = `Client: ${chat.user.name ? `${chat.user.name} (${chat.user.email})` : chat.user.email}`;
    badges.push(clientBadge);

    if (chat.user.disabled) {
      const disabledBadge = document.createElement('span');
      disabledBadge.className = 'badge badge-danger';
      disabledBadge.textContent = 'Client disabled';
      badges.push(disabledBadge);
    }

    const projectBadge = document.createElement('span');
    projectBadge.className = 'badge';
    projectBadge.textContent = `Project: ${chat.project.name}`;
    badges.push(projectBadge);

    if (chat.project.deletedAt) {
      const delBadge = document.createElement('span');
      delBadge.className = 'badge badge-danger';
      delBadge.textContent = 'Project deleted';
      badges.push(delBadge);
    } else if (chat.accessRevoked) {
      const revBadge = document.createElement('span');
      revBadge.className = 'badge badge-danger';
      revBadge.textContent = 'Access revoked';
      badges.push(revBadge);
    }
    meta.replaceChildren(...badges);

    const list = byId('admin-transcript-messages');
    const rendered = chat.messages.map((msg) => {
      const item = document.createElement('li');
      item.className = 'message ' + msg.role;
      const author = document.createElement('h2');
      const time = msg.created_at ? ` · ${new Date(msg.created_at).toLocaleString()}` : '';
      author.textContent = (msg.role === 'user' ? 'Client' : 'Assistant') + time;
      const body = document.createElement('div');
      body.className = 'message-body';
      if (msg.role === 'assistant') {
        body.innerHTML = markdown.render(msg.content);
      } else {
        body.textContent = msg.content;
      }
      item.append(author, body);
      return item;
    });
    list.replaceChildren(...rendered);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function refreshHistoryPanel() {
  if (!users.length) await refreshUsers();
  const params = new URLSearchParams();
  if (historyUserFilter.value) params.set('userId', historyUserFilter.value);
  if (historyProjectFilter.value) params.set('projectId', historyProjectFilter.value);
  const qs = params.toString();
  const data = await api('admin/chats' + (qs ? '?' + qs : ''));
  adminChats = data.chats;
  populateHistoryFilters(data.projects || []);
  renderAdminChatsList();
  if (selectedAdminChatId && !adminChats.some((c) => c.id === selectedAdminChatId)) {
    selectedAdminChatId = null;
    byId('admin-transcript-view').hidden = true;
    byId('admin-transcript-placeholder').hidden = false;
  }
}

historyUserFilter.addEventListener('change', () => {
  refreshHistoryPanel().catch((error) => showNotice(error.message, true));
});
historyProjectFilter.addEventListener('change', () => {
  refreshHistoryPanel().catch((error) => showNotice(error.message, true));
});

async function init() {
  try {
    me = await api('me');
    if (me.role !== 'admin') {
      location.replace('/');
      return;
    }
    byId('admin-email').textContent = me.email;
    await refreshUsers();
  } catch (error) {
    showNotice(error.message, true);
  }
}

init();
