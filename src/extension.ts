import * as vscode from 'vscode';

// ✅ EXPANDED: added changeSources and deltaMs for Stage 2 readiness
interface RawEditEvent {
    uri: string;
    changes: readonly vscode.TextDocumentContentChangeEvent[];
    timestamp: number;
    deltaMs: number;
    source: string;
    changeSources: string[];
}

const fileStateCache = new Map<string, any>();

export function activate(context: vscode.ExtensionContext) {

	vscode.window.showInformationMessage('✅ Human vs AI Tracker ACTIVATED');
    console.log('Human vs AI Tracker Activated');

	

    /*
    =====================================================
    1. PASSIVE DOCUMENT OBSERVER
    =====================================================
    */

    const textChangeListener =
        vscode.workspace.onDidChangeTextDocument(async (event) => {

            const uri = event.document.uri.toString();
			// ✅ Filter out VS Code internal documents
        	// WHY: output:, debug:, git:, search: URIs are VS Code's own
        	// internal channels, not real files being edited by the developer.
        	// Tracking them would pollute the analytics with noise.
        	if (!uri.startsWith('file://')) {
            	return;
			}
			if (!fileStateCache.has(uri)) {
            	fileStateCache.set(uri, {
                	openedAt: Date.now(),
                	eventCount: 0,
                	lastEditAt: null
            	});
        	}

            const changes = event.contentChanges;

            // ✅ FIX 1: Increment eventCount and track lastEditAt in cache
            // WHY: Save hook was always persisting eventCount: 0 because it
            // was never updated. This running tally feeds Stage 5's SQLite writes.
            const cached = fileStateCache.get(uri);
            const prevTimestamp = cached?.lastEditAt ?? Date.now();
            const deltaMs = Date.now() - prevTimestamp;

            if (cached) {
                cached.eventCount = (cached.eventCount || 0) + 1;
                cached.lastEditAt = Date.now();
                fileStateCache.set(uri, cached);
            }

            /*
            ============================================
            CLIPBOARD ANALYZER + PER-CHANGE SOURCE TAGS
            ============================================
            */

            // ✅ FIX 2: Per-change source array instead of single source string
            // WHY: A single RawEditEvent can contain multiple simultaneous changes
            // (multi-cursor edits). Stage 2's SpeedAnalyzer needs per-change
            // granularity to compute accurate typing speed vectors.
            const changeSources: string[] = [];

            for (const change of changes) {

                let changeSource = 'TYPING';

                // ✅ FIX 3: Distinguish deletions from insertions
                // WHY: Deletions must never be counted as typing speed events.
                // A backspace or select-delete has text.length === 0 but
                // rangeLength > 0. If fed to the speed analyzer as TYPING,
                // it would corrupt the characters-per-second vector.
                if (change.text.length === 0 && change.rangeLength > 0) {
                    changeSource = 'DELETION';

                } else if (change.text.length >= 20) {

                    try {
                        const clipboardText =
                            await vscode.env.clipboard.readText();

                        if (clipboardText.trim() === change.text.trim()) {
                            changeSource = 'PASTE';
                        }
                    } catch (err) {
                        console.error('Clipboard Read Error:', err);
                    }
                }

                changeSources.push(changeSource);
            }

            // Derive single top-level source from per-change array
            let source = 'TYPING';
            if (changeSources.includes('PASTE')) source = 'PASTE';
            else if (changeSources.every(s => s === 'DELETION')) source = 'DELETION';
			
			const AI_ACCEPT_WINDOW_MS = 2000;
        	const isLikelyAIAccept =
            	lastInlineCompletionUri === uri &&
            	lastInlineCompletionTime !== null &&
            	(Date.now() - lastInlineCompletionTime) < AI_ACCEPT_WINDOW_MS &&
            	changes.some(c => c.text.length >= 20);

        	if (isLikelyAIAccept) {
            	source = 'AI_ACCEPTED';
            	for (let i = 0; i < changeSources.length; i++) {
                	if (changeSources[i] === 'TYPING') {
                    	changeSources[i] = 'AI_ACCEPTED';
                	}
            	}
            	lastInlineCompletionTime = null;
            	lastInlineCompletionUri = null;
            	console.log('AI ACCEPTANCE DETECTED via inline completion window');
			}

            /*
            ============================================
            RAW EVENT CREATION
            ============================================
            */

            // ✅ FIX 4: Added deltaMs and changeSources to RawEditEvent
            // WHY: deltaMs = time since last edit on this file. Stage 2's
            // SpeedAnalyzer needs this to compute chars/sec without having
            // to reconstruct timing from a raw timestamp log.
            const rawEvent: RawEditEvent = {
                uri,
                changes,
                timestamp: Date.now(),
                deltaMs,
                source,
                changeSources
            };

            console.log('RAW EDIT EVENT:', rawEvent);
        });

    /*
    =====================================================
    2. WINDOW SELECTION TRACKER
    =====================================================
    */

    const selectionListener =
        vscode.window.onDidChangeTextEditorSelection((event) => {

            const selections = event.selections.map(selection => ({
                startLine: selection.start.line,
                startCharacter: selection.start.character,
                endLine: selection.end.line,
                endCharacter: selection.end.character
            }));

            console.log('SELECTION EVENT:', {
                uri: event.textEditor.document.uri.toString(),
                selections,
                timestamp: Date.now()
            });
        });

    /*
    =====================================================
    3. FILE OPEN LIFECYCLE HOOK
    =====================================================
    */

    const openListener =
        vscode.workspace.onDidOpenTextDocument((document) => {

            const uri = document.uri.toString();

            fileStateCache.set(uri, {
                openedAt: Date.now(),
                eventCount: 0,
                lastEditAt: null   // ✅ Added: needed by deltaMs calculation above
            });

            console.log('FILE OPENED:', uri);
        });

    /*
    =====================================================
    4. FILE SAVE LIFECYCLE HOOK
    =====================================================
    */

    const saveListener =
    	vscode.workspace.onDidSaveTextDocument((document) => {

        	const uri = document.uri.toString();

        	// ✅ Initialize cache if file was open before extension activated
        	// WHY: onDidOpenTextDocument only fires for files opened AFTER
        	// the extension activates. If practice.py was already open when
        	// F5 was pressed, its cache entry never gets created, resulting
        	// in 'Persisting State: undefined' on save.
        	if (!fileStateCache.has(uri)) {
            	fileStateCache.set(uri, {
                	openedAt: Date.now(),
                	eventCount: 0,
                	lastEditAt: null
            	});
        	}

        	const fileState = fileStateCache.get(uri);

        	console.log('FILE SAVED:', uri);

        	// Now fileState.eventCount will reflect the real edit count
        	// because textChangeListener increments it above
        	console.log('Persisting State:', fileState);

        	/*
        	DATABASE PERSISTENCE PLACEHOLDER
        	Stage 5 will write fileState to SQLite here
        	*/
    	});
    /*
	=====================================================
	5. INLINE AI COMPLETION PROVIDER + AI ACCEPT DETECTOR
	=====================================================
	*/

	let lastInlineCompletionTime: number | null = null;
	let lastInlineCompletionUri: string | null = null;

	const inlineProvider =
    	vscode.languages.registerInlineCompletionItemProvider(
        	{ pattern: '**' },
        	{
            	async provideInlineCompletionItems(document, position) {
                	lastInlineCompletionTime = Date.now();
                	lastInlineCompletionUri = document.uri.toString();
                	console.log('INLINE COMPLETION TRIGGERED at:', {
                    	uri: document.uri.toString(),
                    	line: position.line,
                    	character: position.character,
                    	timestamp: Date.now()
                	});
                	return [];
            	}
        	}
    	);


    /*
    =====================================================
    REGISTER ALL LISTENERS
    =====================================================
    */

    context.subscriptions.push(
        textChangeListener,
        selectionListener,
        openListener,
        saveListener,
        inlineProvider,
        
    );
}

export function deactivate() {}