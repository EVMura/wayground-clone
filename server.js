const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('querystring');

/*
 * Simple quiz platform
 *
 * This server provides a stripped‑down clone of Wayground/Quizizz.  It allows
 * educators to build a custom multiple‑choice quiz, share a join code with
 * participants and collect their results.  Quizzes and participants are
 * stored in memory so they persist only for the lifetime of the server.
 *
 * Routes:
 *   GET  /                → Home page with links to create or join a quiz
 *   GET  /create          → Form to build a new quiz
 *   POST /create          → Save a new quiz and display the join code
 *   GET  /join            → Form for participants to enter a code and name
 *   POST /join            → Register participant and redirect to first question
 *   GET/POST /take/:code/:pid → Display each question; accept answers
 *   GET  /result/:code/:pid  → Display participant result summary
 *   GET  /scoreboard/:code → Display teacher view of all participant scores
 *
 * Static assets (HTML, CSS, JS) are served from the `public` directory.
 */

// In‑memory storage for quizzes
const quizzes = {};

/**
 * Generate a random 6‑digit alphanumeric code for quiz access.
 * @returns {string}
 */
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Read and serve a static file from the public folder.  If the file is not
 * found the callback returns false to indicate a 404 should be sent.
 */
function serveStatic(filepath, res) {
  const fullPath = path.join(__dirname, 'public', filepath);
  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    return false;
  }
  try {
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Parse POST request body into an object.  Returns a promise that resolves
 * with the parsed values.
 */
function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(parse(body));
    });
  });
}

/**
 * Build an HTML page with provided title and body content.  Shared wrapper
 * ensures consistent styles and semantics across dynamic responses.
 */
function page(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 40px; line-height: 1.4; }
    h1, h2, h3 { color: #333; }
    table { border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 8px 12px; border: 1px solid #ccc; text-align: left; }
    .btn { display: inline-block; padding: 8px 16px; margin-top: 10px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; }
    .btn:hover { background: #0056b3; }
    .error { color: red; }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // Serve static files from /public
  if (req.method === 'GET' && !['/', '/create', '/join'].includes(pathname) && !pathname.startsWith('/take') && !pathname.startsWith('/result') && !pathname.startsWith('/scoreboard')) {
    const served = serveStatic(pathname, res);
    if (!served) {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  // Home page
  if (req.method === 'GET' && pathname === '/') {
    const homeFile = fs.readFileSync(path.join(__dirname, 'public', 'home.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(homeFile);
    return;
  }

  // Display quiz creation form
  if (req.method === 'GET' && pathname === '/create') {
    const createFile = fs.readFileSync(path.join(__dirname, 'public', 'create.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(createFile);
    return;
  }

  // Handle creation form submission
  if (req.method === 'POST' && pathname === '/create') {
    const body = await parseBody(req);
    const title = body.title && body.title.trim();
    let questions;
    try {
      questions = JSON.parse(body.data);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Error', `<h1>Error</h1><p class="error">Invalid quiz data submitted.</p><p><a href="/create" class="btn">Back</a></p>`));
      return;
    }
    if (!title || !Array.isArray(questions) || questions.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Error', `<h1>Error</h1><p class="error">Please provide a quiz title and at least one question.</p><p><a href="/create" class="btn">Back</a></p>`));
      return;
    }
    // Create unique code and store quiz
    let code;
    do {
      code = generateCode();
    } while (quizzes[code]);
    quizzes[code] = {
      title,
      questions,
      participants: {}
    };
    // Respond with join code and teacher link
    const bodyHtml = `
      <h1>Quiz Created</h1>
      <p>Your quiz "${title}" has been created.</p>
      <p><strong>Quiz Code:</strong> ${code}</p>
      <p>Share this join link with participants: <br><code>${code}</code></p>
      <p><a href="/scoreboard/${code}" class="btn">View Scoreboard (Teacher)</a></p>
      <p><a href="/" class="btn">Home</a></p>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Quiz Created', bodyHtml));
    return;
  }

  // Display join form
  if (req.method === 'GET' && pathname === '/join') {
    const joinFile = fs.readFileSync(path.join(__dirname, 'public', 'join.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(joinFile);
    return;
  }

  // Handle join submission
  if (req.method === 'POST' && pathname === '/join') {
    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    const name = (body.name || '').trim();
    if (!quizzes[code]) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Quiz Not Found', `<h1>Quiz Not Found</h1><p class="error">No quiz exists with code ${code}.</p><p><a href="/join" class="btn">Try Again</a></p>`));
      return;
    }
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Invalid Name', `<h1>Invalid Name</h1><p class="error">Please provide your name.</p><p><a href="/join" class="btn">Back</a></p>`));
      return;
    }
    // Create participant ID
    const pid = generateCode();
    quizzes[code].participants[pid] = {
      name,
      answers: [],
      score: 0
    };
    // Redirect to take quiz
    res.writeHead(302, { Location: `/take/${code}/${pid}` });
    res.end();
    return;
  }

  // Display question page or process answer
  if ((req.method === 'GET' || req.method === 'POST') && pathname.startsWith('/take/')) {
    const parts = pathname.split('/');
    const code = parts[2];
    const pid = parts[3];
    const quiz = quizzes[code];
    if (!quiz || !quiz.participants[pid]) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Not Found', `<h1>Not Found</h1><p class="error">Invalid quiz or participant.</p>`));
      return;
    }
    const participant = quiz.participants[pid];
    // If POST, record answer
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const answerIndex = parseInt(body.answer);
      const qIndex = participant.answers.length;
      if (!isNaN(answerIndex) && quiz.questions[qIndex]) {
        participant.answers.push(answerIndex);
        // update score if correct
        if (answerIndex === quiz.questions[qIndex].correct) {
          participant.score++;
        }
      }
    }
    const currentIndex = participant.answers.length;
    // If finished all questions
    if (currentIndex >= quiz.questions.length) {
      res.writeHead(302, { Location: `/result/${code}/${pid}` });
      res.end();
      return;
    }
    // Display next question
    const q = quiz.questions[currentIndex];
    let optionsHtml = '';
    q.options.forEach((opt, idx) => {
      optionsHtml += `<label><input type="radio" name="answer" value="${idx}" required> ${opt}</label><br>`;
    });
    const bodyHtml = `
      <h1>${quiz.title}</h1>
      <h2>Question ${currentIndex + 1} of ${quiz.questions.length}</h2>
      <p>${q.question}</p>
      <form method="POST" action="/take/${code}/${pid}">
        ${optionsHtml}
        <button type="submit" class="btn">Submit Answer</button>
      </form>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(`Question ${currentIndex + 1}`, bodyHtml));
    return;
  }

  // Display result for participant
  if (req.method === 'GET' && pathname.startsWith('/result/')) {
    const parts = pathname.split('/');
    const code = parts[2];
    const pid = parts[3];
    const quiz = quizzes[code];
    if (!quiz || !quiz.participants[pid]) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Not Found', `<h1>Not Found</h1><p class="error">Invalid quiz or participant.</p>`));
      return;
    }
    const participant = quiz.participants[pid];
    const total = quiz.questions.length;
    const bodyHtml = `
      <h1>${quiz.title} – Results</h1>
      <p>Thank you, ${participant.name}! You answered ${participant.score} out of ${total} questions correctly.</p>
      <p><a href="/" class="btn">Return Home</a></p>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Results', bodyHtml));
    return;
  }

  // Display scoreboard for teacher
  if (req.method === 'GET' && pathname.startsWith('/scoreboard/')) {
    const parts = pathname.split('/');
    const code = parts[2];
    const quiz = quizzes[code];
    if (!quiz) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Quiz Not Found', `<h1>Quiz Not Found</h1><p class="error">No quiz exists with code ${code}.</p>`));
      return;
    }
    let rows = '';
    Object.entries(quiz.participants).forEach(([pid, p]) => {
      rows += `<tr><td>${p.name}</td><td>${p.score}</td><td>${quiz.questions.length}</td></tr>`;
    });
    const bodyHtml = `
      <h1>Scoreboard – ${quiz.title}</h1>
      <p>Quiz Code: ${code}</p>
      <table>
        <thead><tr><th>Participant</th><th>Correct</th><th>Total Questions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p><a href="/" class="btn">Home</a></p>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Scoreboard', bodyHtml));
    return;
  }

  // Default 404
  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz server listening on http://localhost:${PORT}`);
});
