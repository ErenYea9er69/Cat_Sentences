pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allSentences = [];
let categorizedSentences = {};
let categories = [];

async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + ' ';
  }

  return fullText;
}

function splitIntoSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.map(s => s.trim()).filter(s => s.length > 10);
}

async function callLongCatAPI(apiKey, messages, maxTokens = 2000) {
  const response = await fetch('https://api.longcat.chat/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'LongCat-Flash-Chat',
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function updateProgress(percent, status) {
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressFill').textContent = Math.round(percent) + '%';
  document.getElementById('statusText').textContent = status;
}

function showError(message) {
  const statusDiv = document.getElementById('statusText');
  statusDiv.className = 'status error';
  statusDiv.textContent = '❌ Error: ' + message;
}

async function identifyCategories(apiKey, sampleSentences) {
  updateProgress(5, 'Step 1/3: Identifying categories from document...');

  const prompt = `Analyze these sample sentences from a document and identify EXACTLY 20-30 specific categories that cover all the main topics in the document.

IMPORTANT RULES:
- Create EXACTLY between 20 and 30 categories (no more, no less)
- Each category should be specific and clear (e.g., "Climate Change Impact" NOT "Nature + Environment")
- DO NOT use "+" or "and" to combine topics - make separate categories instead
- DO NOT use quotes or special characters in category names
- Use simple alphanumeric characters, spaces, and hyphens only
- Categories should be focused but not overly narrow
- Group related sentences under the same category when they share the same main topic
- Balance between being specific and being practical

Sample sentences:
${sampleSentences.slice(0, 100).join('\n')}

Return ONLY a valid JSON array of exactly 20-30 category names, nothing else.
Format: ["Category 1", "Category 2", "Category 3", ...]`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 3000);
  
  // Try to extract and parse JSON
  let jsonMatch = response.match(/\[.*\]/s);
  if (!jsonMatch) throw new Error('No JSON array found in AI response');
  
  let jsonStr = jsonMatch[0];
  
  // Clean up common JSON issues
  jsonStr = jsonStr.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
  jsonStr = jsonStr.replace(/\n/g, ' '); // Remove newlines inside strings
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse JSON:', jsonStr);
    throw new Error('Failed to parse categories from AI response: ' + e.message);
  }
}

async function categorizeBatch(apiKey, sentences, categories, batchIndex, totalBatches) {
  const percent = 10 + (batchIndex / totalBatches) * 80;
  updateProgress(percent, `Step 2/3: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);

  const prompt = `You must categorize each sentence into ONE category from the list below.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}

SENTENCES TO CATEGORIZE:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

CRITICAL: Return ONLY a JSON array with ${sentences.length} category names. No explanations, no extra text.
Example format: ["Category Name", "Category Name", "Category Name"]

JSON array:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 4000);
  
  // Try multiple methods to extract JSON
  let jsonStr = null;
  
  // Method 1: Look for array between brackets
  let jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  } else {
    // Method 2: Try to find it after "JSON array:" or similar
    const afterColon = response.split(/(?:JSON array:|array:|output:)/i).pop();
    if (afterColon) {
      jsonMatch = afterColon.match(/\[[\s\S]*?\]/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }
  }
  
  if (!jsonStr) {
    console.error('AI Response:', response);
    throw new Error('No JSON array found in AI response. Check console for details.');
  }
  
  // Clean up JSON string
  jsonStr = jsonStr.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
  jsonStr = jsonStr.replace(/\n/g, ' '); // Remove newlines
  jsonStr = jsonStr.replace(/,\s*]/g, ']'); // Remove trailing commas
  
  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) {
      throw new Error('Response is not an array');
    }
    if (result.length !== sentences.length) {
      console.warn(`Expected ${sentences.length} categories, got ${result.length}`);
    }
    return result;
  } catch (e) {
    console.error('Failed to parse JSON:', jsonStr);
    console.error('Original response:', response);
    throw new Error('Failed to parse categorization: ' + e.message);
  }
}

function displayResults() {
  updateProgress(100, 'Complete! Displaying results...');
  const container = document.getElementById('categoriesContainer');
  container.innerHTML = '';

  for (const [category, sentences] of Object.entries(categorizedSentences)) {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'category';

    const title = document.createElement('h3');
    title.textContent = `${category} (${sentences.length} sentences)`;
    categoryDiv.appendChild(title);

    sentences.forEach(sentence => {
      const sentenceDiv = document.createElement('div');
      sentenceDiv.className = 'sentence';
      sentenceDiv.textContent = sentence;
      categoryDiv.appendChild(sentenceDiv);
    });

    container.appendChild(categoryDiv);
  }

  document.getElementById('resultsSection').style.display = 'block';
}

function downloadResults() {
  const dataStr = JSON.stringify(categorizedSentences, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'categorized_sentences.json';
  link.click();
  URL.revokeObjectURL(url);
}

function downloadAsPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - (margin * 2);
  let yPosition = margin;

  // Color palette
  const colors = {
    primary: [102, 126, 234],
    secondary: [118, 75, 162],
    text: [51, 51, 51],
    lightGray: [248, 249, 250],
    darkGray: [108, 117, 125]
  };

  // Helper function to add a new page with header
  function addNewPage() {
    doc.addPage();
    yPosition = margin;
    
    // Add page number footer
    doc.setFontSize(9);
    doc.setTextColor(...colors.darkGray);
    doc.text(
      `Page ${doc.internal.getNumberOfPages()}`,
      pageWidth / 2,
      pageHeight - 10,
      { align: 'center' }
    );
  }

  // Title Page
  doc.setFillColor(...colors.primary);
  doc.rect(0, 0, pageWidth, 60, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(28);
  doc.setFont(undefined, 'bold');
  doc.text('Categorized Sentences', pageWidth / 2, 35, { align: 'center' });
  
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  const today = new Date().toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  doc.text(`Generated on ${today}`, pageWidth / 2, 50, { align: 'center' });

  yPosition = 80;

  // Summary Section
  doc.setTextColor(...colors.text);
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text('Summary', margin, yPosition);
  yPosition += 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'normal');
  
  const totalSentencesCount = Object.values(categorizedSentences).reduce((acc, arr) => acc + arr.length, 0);
  const totalCategoriesCount = Object.keys(categorizedSentences).length;
  
  doc.text(`Total Sentences: ${totalSentencesCount}`, margin, yPosition);
  yPosition += 7;
  doc.text(`Total Categories: ${totalCategoriesCount}`, margin, yPosition);
  yPosition += 15;

  // Table of Contents
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text('Table of Contents', margin, yPosition);
  yPosition += 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'normal');
  
  let categoryIndex = 1;
  for (const [category, sentences] of Object.entries(categorizedSentences)) {
    if (yPosition > pageHeight - 30) {
      addNewPage();
    }
    doc.setTextColor(...colors.primary);
    doc.text(`${categoryIndex}. ${category} (${sentences.length} sentences)`, margin + 5, yPosition);
    yPosition += 7;
    categoryIndex++;
  }

  // Start new page for categories
  addNewPage();

  // Category Details
  categoryIndex = 1;
  for (const [category, sentences] of Object.entries(categorizedSentences)) {
    // Check if we need a new page for category header
    if (yPosition > pageHeight - 40) {
      addNewPage();
    }

    // Category Header with background
    doc.setFillColor(...colors.primary);
    doc.roundedRect(margin, yPosition - 8, contentWidth, 15, 3, 3, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text(`${categoryIndex}. ${category}`, margin + 5, yPosition);
    
    doc.setFontSize(10);
    doc.text(`${sentences.length} sentences`, pageWidth - margin - 5, yPosition, { align: 'right' });
    
    yPosition += 18;

    // Sentences
    doc.setTextColor(...colors.text);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10);
    
    sentences.forEach((sentence, idx) => {
      // Check if we need a new page
      if (yPosition > pageHeight - 40) {
        addNewPage();
      }

      // Sentence number and bullet
      const sentenceNum = `${idx + 1}.`;
      doc.setTextColor(...colors.darkGray);
      doc.text(sentenceNum, margin + 3, yPosition);
      
      // Sentence text with proper wrapping
      doc.setTextColor(...colors.text);
      const textX = margin + 12;
      const wrapped = doc.splitTextToSize(sentence, contentWidth - 12);
      
      // Add light background for alternating sentences
      if (idx % 2 === 0) {
        doc.setFillColor(...colors.lightGray);
        const textHeight = wrapped.length * 5 + 4;
        doc.roundedRect(margin, yPosition - 4, contentWidth, textHeight, 2, 2, 'F');
      }
      
      doc.text(wrapped, textX, yPosition);
      yPosition += (wrapped.length * 5) + 6;
    });
    
    yPosition += 10; // Space after category
    categoryIndex++;
  }

  // Add page numbers to all pages
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(9);
    doc.setTextColor(...colors.darkGray);
    if (i > 1) { // Skip first page footer (title page already has custom footer)
      doc.text(
        `Page ${i} of ${totalPages}`,
        pageWidth / 2,
        pageHeight - 10,
        { align: 'center' }
      );
    }
  }

  doc.save('categorized_sentences.pdf');
}

async function startProcessing() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const batchSize = parseInt(document.getElementById('batchSize').value);
  const fileInput = document.getElementById('pdfFile');

  if (!apiKey) return alert('Please enter your LongCat API key');
  if (!fileInput.files[0]) return alert('Please select a PDF file');

  document.getElementById('startBtn').disabled = true;
  document.getElementById('progressSection').style.display = 'block';
  document.getElementById('resultsSection').style.display = 'none';

  try {
    updateProgress(0, 'Extracting text from PDF...');
    const text = await extractTextFromPDF(fileInput.files[0]);
    allSentences = splitIntoSentences(text);
    document.getElementById('totalSentences').textContent = allSentences.length;

    if (allSentences.length === 0) throw new Error('No sentences found in PDF');

    updateProgress(3, `Found ${allSentences.length} sentences. Analyzing...`);
    categories = await identifyCategories(apiKey, allSentences);
    document.getElementById('totalCategories').textContent = categories.length;
    updateProgress(10, `Identified ${categories.length} categories`);

    categorizedSentences = {};
    categories.forEach(cat => categorizedSentences[cat] = []);

    const totalBatches = Math.ceil(allSentences.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, allSentences.length);
      const batch = allSentences.slice(start, end);

      const batchCategories = await categorizeBatch(apiKey, batch, categories, i, totalBatches);
      batch.forEach((sentence, idx) => {
        const category = batchCategories[idx] || 'Uncategorized';
        if (!categorizedSentences[category]) categorizedSentences[category] = [];
        categorizedSentences[category].push(sentence);
      });

      document.getElementById('processedCount').textContent = end;
      await new Promise(res => setTimeout(res, 1000));
    }

    displayResults();
  } catch (error) {
    showError(error.message);
    console.error(error);
  } finally {
    document.getElementById('startBtn').disabled = false;
  }
}