'use strict';

const error = document.getElementById('error');
const reason = new URLSearchParams(location.search).get('error');

if (reason === 'rate') {
  error.textContent = 'Too many attempts. Wait 10 minutes and try again.';
  error.hidden = false;
} else if (reason) {
  error.textContent = 'That password did not match.';
  error.hidden = false;
}
