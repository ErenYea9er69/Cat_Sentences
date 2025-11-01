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

  const prompt = `Analyze these sample sentences and identify EXACTLY 25-40 CLEAR and SPECIFIC THEMATIC categories based on the main topics and subjects discussed in the document.

CRITICAL RULES:
- Create EXACTLY between 25 and 40 categories
- Categories should be CLEAR, SPECIFIC TOPICS or THEMES
- Each category should be distinct and not overlap with others
- Think about the SUBJECT MATTER: What is this sentence about?
- Use DESCRIPTIVE names that clearly indicate what the category contains
- Categories should be specific enough to be meaningful but broad enough to contain multiple sentences
- Use clear, descriptive names (2-5 words)
- NO special characters, quotes, or symbols in category names
- Avoid vague or overly general categories

Example of GOOD categories: "Water Transportation and Vessels", "Urban Infrastructure and Buildings", "Food Preparation and Cooking", "Medical Treatment and Healthcare", "Emotional Reactions and Feelings"
Example of BAD categories: "Items", "Activities", "Things", "Stuff", "General"

Sample sentences:
${sampleSentences.slice(0, 150).join('\n')}

Analyze the main TOPICS and THEMES across all sentences, then return ONLY a JSON array of 25-40 clear and specific thematic category names.
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
    const categories = JSON.parse(jsonStr);
    console.log('Identified categories:', categories);
    return categories;
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

  // Store page numbers where each category starts for links
  const categoryPages = {};

  // Helper function to add a new page
  function addNewPage() {
    doc.addPage();
    yPosition = margin;
    
    // Add page number footer
    doc.setFontSize(9);
    doc.setTextColor(128, 128, 128);
    doc.text(
      `${doc.internal.getNumberOfPages()}`,
      pageWidth / 2,
      pageHeight - 10,
      { align: 'center' }
    );
    doc.setTextColor(0, 0, 0);
  }

  // ============ TITLE PAGE ============
  doc.setFontSize(32);
  doc.setFont(undefined, 'bold');
  doc.text('Categorized Sentences', pageWidth / 2, 80, { align: 'center' });
  
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  const today = new Date().toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  doc.text(`Generated on ${today}`, pageWidth / 2, 95, { align: 'center' });

  // Start TOC on new page
  addNewPage();

  // ============ TABLE OF CONTENTS ============
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('Table of Contents', margin, yPosition);
  yPosition += 12;

  doc.setFontSize(10);
  
  let categoryIndex = 1;
  const sortedCategories = Object.entries(categorizedSentences).sort((a, b) => b[1].length - a[1].length);
  
  for (const [category, sentences] of sortedCategories) {
    if (yPosition > pageHeight - 25) {
      addNewPage();
    }
    
    // Store the position for later linking (we'll update after we know the actual pages)
    const tocText = `${categoryIndex}. ${category}`;
    const tocY = yPosition;
    const tocPage = doc.internal.getNumberOfPages();
    
    // Store TOC entry info for later updating
    if (!doc.tocEntries) doc.tocEntries = [];
    doc.tocEntries.push({
      category: category,
      tocPage: tocPage,
      tocY: tocY,
      tocText: tocText,
      index: categoryIndex
    });
    
    // Calculate available width for category name
    const countText = `(${sentences.length} sentences)`;
    const countWidth = doc.getTextWidth(countText);
    const availableWidth = contentWidth - countWidth - 10;
    
    // Wrap category text if needed
    const wrappedCategory = doc.splitTextToSize(`${categoryIndex}. ${category}`, availableWidth);
    
    // Add the category name
    doc.setFont(undefined, 'normal');
    doc.text(wrappedCategory, margin + 5, yPosition);
    
    // Add sentence count aligned to the right on the first line
    doc.text(countText, pageWidth - margin - 5, yPosition, { align: 'right' });
    
    yPosition += (wrappedCategory.length * 5) + 2;
    categoryIndex++;
  }

  // ============ CATEGORY CONTENT PAGES ============
  addNewPage();

  categoryIndex = 1;
  for (const [category, sentences] of sortedCategories) {
    // Store the page where this category starts
    categoryPages[category] = doc.internal.getNumberOfPages();
    
    // Check if we need a new page for category header
    if (yPosition > pageHeight - 50) {
      addNewPage();
      categoryPages[category] = doc.internal.getNumberOfPages();
    }

    // Category Header (Bold)
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    const categoryTitle = `${categoryIndex}. ${category}`;
    
    // Wrap the title if it's too long
    const wrappedTitle = doc.splitTextToSize(categoryTitle, contentWidth - 30);
    doc.text(wrappedTitle, margin, yPosition);
    
    const titleHeight = wrappedTitle.length * 6;
    
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(`${sentences.length} sentences`, pageWidth - margin, yPosition, { align: 'right' });
    
    yPosition += titleHeight + 2;
    
    // Draw a line under the category
    doc.setDrawColor(0, 0, 0);
    doc.line(margin, yPosition, pageWidth - margin, yPosition);
    yPosition += 8;

    // Sentences
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    
    sentences.forEach((sentence, idx) => {
      // Check if we need a new page
      if (yPosition > pageHeight - 35) {
        addNewPage();
      }

      // Sentence number
      const sentenceNum = `${idx + 1}.`;
      doc.text(sentenceNum, margin, yPosition);
      
      // Sentence text with proper wrapping
      const textX = margin + 10;
      const wrapped = doc.splitTextToSize(sentence, contentWidth - 10);
      doc.text(wrapped, textX, yPosition);
      
      yPosition += (wrapped.length * 6) + 3;
    });
    
    yPosition += 8; // Space after category
    categoryIndex++;
  }

  // ============ UPDATE TABLE OF CONTENTS LINKS ============
  // Now go back and update all the TOC links with the actual page numbers
  if (doc.tocEntries) {
    doc.tocEntries.forEach(entry => {
      const targetPage = categoryPages[entry.category];
      if (targetPage) {
        doc.setPage(entry.tocPage);
        
        // Calculate available width for category name
        const countText = `(${categorizedSentences[entry.category].length} sentences)`;
        const countWidth = doc.getTextWidth(countText);
        const availableWidth = contentWidth - countWidth - 10;
        
        // Create the clickable link
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(0, 0, 255); // Blue color for links
        
        const linkText = `${entry.index}. ${entry.category}`;
        const wrappedLink = doc.splitTextToSize(linkText, availableWidth);
        
        doc.textWithLink(wrappedLink, margin + 5, entry.tocY, { 
          pageNumber: targetPage
        });
        doc.setTextColor(0, 0, 0); // Reset to black
      }
    });
  }

  // Go back to last page to ensure proper page count
  doc.setPage(doc.internal.getNumberOfPages());

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