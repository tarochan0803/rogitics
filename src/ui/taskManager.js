import { html } from '../utils/html.js';

const tasks = new Map();

export function createTask(id, label) {
    const container = document.getElementById('taskManager');
    if (!container) return;

    if (tasks.has(id)) {
        updateTask(id, 0, label);
        return;
    }

    const el = document.createElement('div');
    el.className = 'task-item glassmorphic';
    el.id = `task-${id}`;
    // XSS対策: label は呼び出し元から渡される文字列。html`` で自動エスケープ。
    el.innerHTML = html`
    <div class="task-info">
      <span class="task-label">${label}</span>
      <span class="task-percent">0%</span>
    </div>
    <div class="task-progress-bg">
      <div class="task-progress-fg" style="width: 0%"></div>
    </div>
  `;
    container.appendChild(el);
    tasks.set(id, { el, label });
}

export function updateTask(id, progress, label) {
    const task = tasks.get(id);
    if (!task) {
        createTask(id, label || 'Processing...');
        return;
    }

    const percent = Math.round(progress * 100);
    const fg = task.el.querySelector('.task-progress-fg');
    const txt = task.el.querySelector('.task-percent');
    const lbl = task.el.querySelector('.task-label');

    if (fg) fg.style.width = `${percent}%`;
    if (txt) txt.textContent = `${percent}%`;
    if (label && lbl) lbl.textContent = label;
}

export function removeTask(id) {
    const task = tasks.get(id);
    if (!task) return;

    task.el.classList.add('fade-out');
    setTimeout(() => {
        task.el.remove();
        tasks.delete(id);
    }, 300);
}

export function clearTasks() {
    for (const id of tasks.keys()) {
        removeTask(id);
    }
}
