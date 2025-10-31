pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allSentences = [];
let categorizedSentences = {};
let categories = [];

async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
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
    return sentences.map(s => s.trim()).filter(s => s.length > 20); // Improved filter
}

async function callLongCatAPI(apiKey, messages, maxTokens = 3000) { // Increased maxTokens
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
            temperature: 0.2 // Lowered for consistency
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
    statusDiv.className = 'error';
    statusDiv.textContent = '❌ Error: ' + message;
}

async function identifyCategories(apiKey, sampleSentences) {
    updateProgress(5, 'Step 1/3: Identifying categories from document...');
    
    const prompt = `Analyze these sample sentences from a document and identify 5-15 main categories that comprehensively cover all topics. Return ONLY a JSON array of category names.

Sample sentences:
${sampleSentences.slice(0, 150).join('\n')}  // Larger sample

Return format: ["Category1", "Category2", ...]`;

    const messages = [{role: 'user', content: prompt}];
    const response = await callLongCatAPI(apiKey, messages);
    const jsonMatch = response.match(/\[.*\]/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to parse categories');
}

async function categorizeBatch(apiKey, sentences, categories, batchIndex, totalBatches) {
    const percent = 10 + (batchIndex / totalBatches) * 80;
    updateProgress(percent, `Step 2/3: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);

    const prompt = `Categorize each sentence into EXACTLY ONE of these categories: ${categories.join(', ')}. If unsure, use "Other".

Sentences:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Return ONLY JSON array: ["Category", "Category", ...]`;

    const messages = [{role: 'user', content: prompt}];
    const response = await callLongCatAPI(apiKey, messages);
    const jsonMatch = response.match(/\[.*\]/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to parse categorization');
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

function downloadJson() {
    const dataStr = JSON.stringify(categorizedSentences, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'categorized_sentences.json';
    link.click();
    URL.revokeObjectURL(url);
}

function downloadPdf() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 10;
    doc.setFontSize(16);
    doc.text('Categorized Sentences', 10, y);
    y += 10;

    for (const [category, sentences] of Object.entries(categorizedSentences)) {
        doc.setFontSize(14);
        doc.text(category, 10, y);
        y += 8;
        doc.setFontSize(10);
        sentences.forEach(sentence => {
            const lines = doc.splitTextToSize(sentence, 180);
            doc.text(lines, 10, y);
            y += lines.length * 6;
            if (y > 270) {
                doc.addPage();
                y = 10;
            }
        });
        y += 5;
        if (y > 270) {
            doc.addPage();
            y = 10;
        }
    }

    doc.save('categorized_sentences.pdf');
}

async function startProcessing() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const batchSize = parseInt(document.getElementById('batchSize').value);
    const fileInput = document.getElementById('pdfFile');

    if (!apiKey || !fileInput.files[0]) {
        alert('API key and PDF required');
        return;
    }

    document.getElementById('startBtn').disabled = true;
    document.getElementById('progressSection').style.display = 'block';
    document.getElementById('resultsSection').style.display = 'none';

    try {
        updateProgress(0, 'Extracting text from PDF...');
        const text = await extractTextFromPDF(fileInput.files[0]);
        allSentences = splitIntoSentences(text);
        
        if (allSentences.length === 0) throw new Error('No sentences found');

        updateProgress(3, `Found ${allSentences.length} sentences. Analyzing...`);

        categories = await identifyCategories(apiKey, allSentences);
        updateProgress(10, `Identified ${categories.length} categories`);

        categorizedSentences = {};
        categories.forEach(cat => categorizedSentences[cat] = []);
        categorizedSentences['Other'] = []; // Added fallback

        const totalBatches = Math.ceil(allSentences.length / batchSize);
        
        for (let i = 0; i < totalBatches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, allSentences.length);
            const batch = allSentences.slice(start, end);

            const batchCategories = await categorizeBatch(apiKey, batch, categories, i, totalBatches);

            batch.forEach((sentence, idx) => {
                const category = batchCategories[idx] || 'Other';
                categorizedSentences[category].push(sentence);
            });

            await new Promise(resolve => setTimeout(resolve, 500)); 
        }

        displayResults();

    } catch (error) {
        showError(error.message);
        console.error(error);
    } finally {
        document.getElementById('startBtn').disabled = false;
    }
}