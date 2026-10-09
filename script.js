const leadDialog = document.querySelector('#lead-dialog');
const resumeDialog = document.querySelector('#resume-dialog');
const serviceField = document.querySelector('#service-field');
const leadForm = document.querySelector('#lead-form');
const formNote = document.querySelector('#form-note');
const resumeForm = document.querySelector('#resume-form');
const resumeNote = document.querySelector('#resume-note');

document.querySelectorAll('.js-open-form').forEach((button) => {
  button.addEventListener('click', () => {
    serviceField.value = button.dataset.service || 'Консультация';
    leadDialog.showModal();
  });
});

document.querySelectorAll('.js-open-resume').forEach((button) => {
  button.addEventListener('click', () => {
    resumeNote.textContent = '';
    resumeDialog.showModal();
  });
});

document.querySelectorAll('.dialog-close').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});

leadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  formNote.textContent = 'Подключаем передачу заявок в Bitrix24. Форма станет активной перед публикацией.';
  formNote.style.color = '#d8ff00';
});

resumeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = resumeForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Обрабатываем…';
  resumeNote.textContent = 'Читаем резюме и создаём карточку кандидата. Это может занять до минуты.';
  resumeNote.style.color = '#d8ff00';

  try {
    const response = await fetch('/candidate-upload', {
      method: 'POST',
      body: new FormData(resumeForm)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'Не удалось загрузить резюме.');

    resumeNote.textContent = result.message;
    resumeNote.style.color = '#d8ff00';
    resumeForm.reset();
    submitButton.textContent = 'Резюме отправлено';
    setTimeout(() => resumeDialog.close(), 1800);
  } catch (error) {
    resumeNote.textContent = error.message || 'Не удалось загрузить резюме. Попробуйте ещё раз.';
    resumeNote.style.color = '#ff7a7a';
    submitButton.textContent = 'Отправить резюме';
    submitButton.disabled = false;
  }
});
