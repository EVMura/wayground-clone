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
 * Helper to compare two arrays of numbers for set equality (order‑insensitive).
 * @param {number[]} a
 * @param {number[]} b
 */
function arraysEqualUnordered(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

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
      participants: {},
      // maintain whitelist and blacklist of IP addresses for access control
      whitelist: new Set(),
      blacklist: new Set()
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
    const quiz = quizzes[code];
    if (!quiz) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Quiz Not Found', `<h1>Quiz Not Found</h1><p class="error">No quiz exists with code ${code}.</p><p><a href="/join" class="btn">Try Again</a></p>`));
      return;
    }
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Invalid Name', `<h1>Invalid Name</h1><p class="error">Please provide your name.</p><p><a href="/join" class="btn">Back</a></p>`));
      return;
    }
    // Determine requester IP; Render proxies may forward real IP via x-forwarded-for
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader) || req.socket.remoteAddress || '';
    // Access control: deny if in blacklist or not in whitelist when whitelist is non-empty
    if (quiz.blacklist && quiz.blacklist.has(ip)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Access Denied', `<h1>Access Denied</h1><p class="error">Your device is not permitted to join this quiz.</p><p><a href="/" class="btn">Home</a></p>`));
      return;
    }
    if (quiz.whitelist && quiz.whitelist.size > 0 && !quiz.whitelist.has(ip)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Access Restricted', `<h1>Access Restricted</h1><p class="error">This quiz is restricted to approved participants.</p><p><a href="/" class="btn">Home</a></p>`));
      return;
    }
    // Create participant ID
    const pid = generateCode();
    quiz.participants[pid] = {
      name,
      answers: [],
      score: 0,
      ip
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
    // If POST, record answer(s)
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const qIndex = participant.answers.length;
      const q = quiz.questions[qIndex];
      let selected;
      if (body.answer === undefined) {
        selected = [];
      } else if (Array.isArray(body.answer)) {
        selected = body.answer.map(x => parseInt(x)).filter(n => !isNaN(n));
      } else {
        const val = parseInt(body.answer);
        selected = isNaN(val) ? [] : [val];
      }
      participant.answers.push(selected);
      // update score if correct (arrays equal)
      const correctIndices = Array.isArray(q.correct) ? q.correct : [q.correct];
      if (arraysEqualUnordered(selected, correctIndices)) {
        participant.score++;
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
      const text = typeof opt === 'string' ? opt : opt.text;
      const image = opt.image ? `<br><img src="${opt.image}" alt="option image" style="max-width:200px;max-height:150px;">` : '';
      optionsHtml += `<label class="option-card"><input type="checkbox" name="answer" value="${idx}"> <span>${text}</span>${image}</label>`;
    });
    const qImage = q.questionImage ? `<img src="${q.questionImage}" alt="question image" style="max-width:300px;max-height:200px;">` : '';
    const bodyHtml = `
      <h1>${quiz.title}</h1>
      <h2>Question ${currentIndex + 1} of ${quiz.questions.length}</h2>
      <p>${q.question}</p>
      ${qImage}
      <form method="POST" action="/take/${code}/${pid}">
        <div class="options-container">${optionsHtml}</div>
        <button type="submit" class="btn">Submit</button>
      </form>
    `;
    // supply minimal CSS for option cards
    const styles = `
      <style>
        .options-container { display: flex; flex-wrap: wrap; gap: 10px; }
        .option-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: flex-start;
          width: 200px;
          min-height: 120px;
          padding: 10px;
          border-radius: 6px;
          background-color: #f0f0f0;
        }
        .option-card:nth-child(1) { background-color: #4e79a7; color: white; }
        .option-card:nth-child(2) { background-color: #59a14f; color: white; }
        .option-card:nth-child(3) { background-color: #f28e2b; color: white; }
        .option-card:nth-child(4) { background-color: #e15759; color: white; }
        .option-card input { margin-right: 6px; }
        img { margin-top: 8px; }
      </style>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(`Question ${currentIndex + 1}`, styles + bodyHtml));
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
    const percent = total > 0 ? Math.round((participant.score / total) * 100) : 0;
    // Build detailed results listing
    let details = '<ol>';
    quiz.questions.forEach((q, i) => {
      const your = participant.answers[i] || [];
      const correctIndices = Array.isArray(q.correct) ? q.correct : [q.correct];
      const yourTexts = your.map(idx => {
        const opt = q.options[idx];
        return typeof opt === 'string' ? opt : opt.text;
      });
      const correctTexts = correctIndices.map(idx => {
        const opt = q.options[idx];
        return typeof opt === 'string' ? opt : opt.text;
      });
      const isCorrect = arraysEqualUnordered(your, correctIndices);
      details += `<li><strong>Q${i+1}:</strong> ${q.question}<br>`;
      details += `<em>Your answer${yourTexts.length !== 1 ? 's' : ''}:</em> ${yourTexts.join(', ') || '(none)'}<br>`;
      details += `<em>Correct answer${correctTexts.length !== 1 ? 's' : ''}:</em> ${correctTexts.join(', ')}<br>`;
      details += isCorrect ? '<span style="color:green">Correct</span>' : '<span style="color:red">Incorrect</span>';
      details += '</li>';
    });
    details += '</ol>';
    const points = participant.score * 100;
    const bodyHtml = `
      <h1>${quiz.title} – Results</h1>
      <p>Thank you, ${participant.name}!</p>
      <p>You answered <strong>${participant.score}</strong> out of <strong>${total}</strong> questions correctly.</p>
      <p>Percentage: <strong>${percent}%</strong></p>
      <p>Points earned: <strong>${points}</strong></p>
      <h2>Question Breakdown</h2>
      ${details}
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
    // Build rows sorted by score descending
    let rows = '';
    const participantsEntries = Object.entries(quiz.participants);
    participantsEntries.sort((a, b) => b[1].score - a[1].score);
    participantsEntries.forEach(([pid, p]) => {
      rows += `<tr><td>${p.name}</td><td>${p.score}</td><td>${quiz.questions.length}</td><td>${p.ip || ''}</td><td>
        <form method="POST" action="/whitelist/${code}" style="display:inline">
          <input type="hidden" name="ip" value="${p.ip || ''}">
          <button type="submit">Whitelist</button>
        </form>
        <form method="POST" action="/blacklist/${code}" style="display:inline">
          <input type="hidden" name="ip" value="${p.ip || ''}">
          <button type="submit">Blacklist</button>
        </form>
      </td></tr>`;
    });
    // Display current whitelist and blacklist
    const whitelistList = Array.from(quiz.whitelist || []).map(ip => `<li>${ip}</li>`).join('') || '<li>None</li>';
    const blacklistList = Array.from(quiz.blacklist || []).map(ip => `<li>${ip}</li>`).join('') || '<li>None</li>';
    const bodyHtml = `
      <h1>Scoreboard – ${quiz.title}</h1>
      <p>Quiz Code: ${code}</p>
      <table>
        <thead><tr><th>Participant</th><th>Correct</th><th>Total</th><th>IP Address</th><th>Access</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h3>Whitelist</h3><ul>${whitelistList}</ul>
      <h3>Blacklist</h3><ul>${blacklistList}</ul>
      <p><a href="/" class="btn">Home</a></p>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Scoreboard', bodyHtml));
    return;
  }

  // Add an IP to the whitelist
  if (req.method === 'POST' && pathname.startsWith('/whitelist/')) {
    const parts = pathname.split('/');
    const code = parts[2];
    const quiz = quizzes[code];
    if (!quiz) {
      res.writeHead(404);
      res.end('Quiz not found');
      return;
    }
    const body = await parseBody(req);
    const ip = (body.ip || '').trim();
    if (ip) {
      quiz.whitelist.add(ip);
      // Also remove from blacklist if present
      quiz.blacklist.delete(ip);
    }
    res.writeHead(302, { Location: `/scoreboard/${code}` });
    res.end();
    return;
  }

  // Add an IP to the blacklist
  if (req.method === 'POST' && pathname.startsWith('/blacklist/')) {
    const parts = pathname.split('/');
    const code = parts[2];
    const quiz = quizzes[code];
    if (!quiz) {
      res.writeHead(404);
      res.end('Quiz not found');
      return;
    }
    const body = await parseBody(req);
    const ip = (body.ip || '').trim();
    if (ip) {
      quiz.blacklist.add(ip);
      // Removing from whitelist to avoid conflict
      quiz.whitelist.delete(ip);
    }
    res.writeHead(302, { Location: `/scoreboard/${code}` });
    res.end();
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
