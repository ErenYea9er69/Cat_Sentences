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
    statusDiv.className = 'error';
    statusDiv.textContent = '❌ Error: ' + message;
}

async function identifyCategories(apiKey, sampleSentences) {
    updateProgress(5, 'Step 1/3: Identifying categories from document...');
    
    const prompt = `Analyze these sample sentences from a document and identify 5-10 main categories that cover all topics. Return ONLY a JSON array of category names, nothing else.

Sample sentences:
${sampleSentences.slice(0, 100).join('\n')}

Return format: ["Category1", "Category2", "Category3", ...]`;

    const messages = [
        {role: 'user', content: prompt}
    ];

    const response = await callLongCatAPI(apiKey, messages);
    const jsonMatch = response.match(/\[.*\]/s);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse categories from AI response');
}

async function categorizeBatch(apiKey, sentences, categories, batchIndex, totalBatches) {
    const percent = 10 + (batchIndex / totalBatches) * 80;
    updateProgress(percent, `Step 2/3: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);

    const prompt = `Categorize each sentence into ONE of these categories: ${categories.join(', ')}.

Sentences:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Return ONLY a JSON array where each element is the category name for the corresponding sentence number. Format: ["Category", "Category", ...]`;

    const messages = [
        {role: 'user', content: prompt}
    ];

    const response = await callLongCatAPI(apiKey, messages);
    const jsonMatch = response.match(/\[.*\]/s);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse categorization from AI response');
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
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'categorized_sentences.json';
    link.click();
    URL.revokeObjectURL(url);
}

async function startProcessing() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const batchSize = parseInt(document.getElementById('batchSize').value);
    const fileInput = document.getElementById('pdfFile');

    if (!apiKey) {
        alert('Please enter your LongCat API key');
        return;
    }

    if (!fileInput.files[0]) {
        alert('Please select a PDF file');
        return;
    }

    document.getElementById('startBtn').disabled = true;
    document.getElementById('progressSection').style.display = 'block';
    document.getElementById('resultsSection').style.display = 'none';

    try {
        // Step 1: Extract text from PDF
        updateProgress(0, 'Extracting text from PDF...');
        const text = await extractTextFromPDF(fileInput.files[0]);
        allSentences = splitIntoSentences(text);
        
        if (allSentences.length === 0) {
            throw new Error('No sentences found in PDF');
        }

        updateProgress(3, `Found ${allSentences.length} sentences. Analyzing...`);

        // Step 2: Identify categories
        categories = await identifyCategories(apiKey, allSentences);
        updateProgress(10, `Identified ${categories.length} categories: ${categories.join(', ')}`);

        // Initialize category storage
        categorizedSentences = {};
        categories.forEach(cat => categorizedSentences[cat] = []);

        // Step 3: Process in batches
        const totalBatches = Math.ceil(allSentences.length / batchSize);
        
        for (let i = 0; i < totalBatches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, allSentences.length);
            const batch = allSentences.slice(start, end);

            const batchCategories = await categorizeBatch(apiKey, batch, categories, i, totalBatches);

            // Store categorized sentences
            batch.forEach((sentence, idx) => {
                const category = batchCategories[idx] || 'Uncategorized';
                if (!categorizedSentences[category]) {
                    categorizedSentences[category] = [];
                }
                categorizedSentences[category].push(sentence);
            });

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Display results
        displayResults();

    } catch (error) {
        showError(error.message);
        console.error('Processing error:', error);
    } finally {
        document.getElementById('startBtn').disabled = false;
    }
}