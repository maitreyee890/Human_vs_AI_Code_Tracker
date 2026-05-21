import * as vscode from 'vscode';

// ============================================================
// TYPES
// ============================================================

interface RawEditEvent {
    uri: string;
    changes: readonly vscode.TextDocumentContentChangeEvent[];
    timestamp: number;
    deltaMs: number;
    source: 'TYPING' | 'DELETION' | 'PASTE' | 'AI_ACCEPTED';
    changeSources: string[];
}

interface FileState {
    openedAt: number;
    eventCount: number;
    lastEditAt: number | null;
}

// ============================================================
// MODULE-LEVEL STATE  (declared BEFORE all listeners)
// ============================================================

const fileStateCache = new Map<string, FileState>();

let lastInlineCompletionTime: number | null = null;
let lastInlineCompletionUri: string | null = null;

const AI_ACCEPT_WINDOW_MS = 2000;

// URIs we never want to track
function isTrackableUri(uri: string): boolean {
    return uri.startsWith('file://') || uri.startsWith('untitled:');
}

// ============================================================
// ACTIVATE
// ============================================================

export function activate(context: vscode.ExtensionContext) {

    vscode.window.showInformationMessage('✅ Human vs AI Tracker ACTIVATED');
    console.log('[Tracker] Activated');

    // ----------------------------------------------------------
    // 1. PASSIVE DOCUMENT OBSERVER
    // ----------------------------------------------------------

    const textChangeListener =
        vscode.workspace.onDidChangeTextDocument(async (event) => {

            const uri = event.document.uri.toString();

            // Skip non-trackable URIs and empty change arrays
            if (!isTrackableUri(uri)) return;
            if (event.contentChanges.length === 0) return;

            // Ensure cache entry exists
            if (!fileStateCache.has(uri)) {
                fileStateCache.set(uri, {
                    openedAt: Date.now(),
                    eventCount: 0,
                    lastEditAt: null
                });
            }

            const cached = fileStateCache.get(uri)!;
            const prevTimestamp = cached.lastEditAt ?? Date.now();
            const deltaMs = Date.now() - prevTimestamp;

            cached.eventCount += 1;
            cached.lastEditAt = Date.now();

            // --------------------------------------------------
            // PER-CHANGE SOURCE CLASSIFICATION
            // --------------------------------------------------

            const changeSources: string[] = [];

            for (const change of event.contentChanges) {

                // Pure deletion — no text inserted
                if (change.text.length === 0 && change.rangeLength > 0) {
                    changeSources.push('DELETION');
                    continue;
                }

                // Large insertion — check clipboard
                if (change.text.length >= 20) {
                    try {
                        const clip = await vscode.env.clipboard.readText();
                        if (clip.trim() === change.text.trim()) {
                            changeSources.push('PASTE');
                            continue;
                        }
                    } catch (err) {
                        console.error('[Tracker] Clipboard read error:', err);
                    }
                }

                changeSources.push('TYPING');
            }

            // Derive top-level source
            let source: RawEditEvent['source'] = 'TYPING';
            if (changeSources.includes('PASTE')) {
                source = 'PASTE';
            } else if (changeSources.every(s => s === 'DELETION')) {
                source = 'DELETION';
            }

            // --------------------------------------------------
            // AI ACCEPTANCE WINDOW CHECK
            // --------------------------------------------------

            const isLikelyAIAccept =
                lastInlineCompletionUri === uri &&
                lastInlineCompletionTime !== null &&
                (Date.now() - lastInlineCompletionTime) < AI_ACCEPT_WINDOW_MS &&
                event.contentChanges.some(c => c.text.length >= 20);

            if (isLikelyAIAccept) {
                source = 'AI_ACCEPTED';
                for (let i = 0; i < changeSources.length; i++) {
                    if (changeSources[i] === 'TYPING') changeSources[i] = 'AI_ACCEPTED';
                }
                lastInlineCompletionTime = null;
                lastInlineCompletionUri = null;
                console.log('[Tracker] AI_ACCEPTED via inline completion window');
            }

            const rawEvent: RawEditEvent = {
                uri,
                changes: event.contentChanges,
                timestamp: Date.now(),
                deltaMs,
                source,
                changeSources
            };

            console.log('[Tracker] RAW EDIT EVENT:', JSON.stringify({
                uri: rawEvent.uri,
                source: rawEvent.source,
                changeSources: rawEvent.changeSources,
                deltaMs: rawEvent.deltaMs,
                timestamp: rawEvent.timestamp,
                changeCount: rawEvent.changes.length
            }));
        });

    // ----------------------------------------------------------
    // 2. WINDOW SELECTION TRACKER  — only real selections
    // ----------------------------------------------------------

    const selectionListener =
        vscode.window.onDidChangeTextEditorSelection((event) => {

            const uri = event.textEditor.document.uri.toString();
            if (!isTrackableUri(uri)) return;

            const meaningfulSelections = event.selections.filter(
                s => !s.isEmpty   // isEmpty === start equals end (just a caret)
            );

            // Only log if at least one selection actually highlights text,
            // OR if it's a multi-cursor situation (more than one cursor)
            if (meaningfulSelections.length === 0 && event.selections.length <= 1) {
                return;
            }

            console.log('[Tracker] SELECTION EVENT:', JSON.stringify({
                uri,
                selections: event.selections.map(s => ({
                    startLine: s.start.line,
                    startCharacter: s.start.character,
                    endLine: s.end.line,
                    endCharacter: s.end.character,
                    isEmpty: s.isEmpty
                })),
                timestamp: Date.now()
            }));
        });

    // ----------------------------------------------------------
    // 3. FILE OPEN LIFECYCLE HOOK
    // ----------------------------------------------------------

    const openListener =
        vscode.workspace.onDidOpenTextDocument((document) => {

            const uri = document.uri.toString();
            if (!isTrackableUri(uri)) return;

            fileStateCache.set(uri, {
                openedAt: Date.now(),
                eventCount: 0,
                lastEditAt: null
            });

            console.log('[Tracker] FILE OPENED:', uri);
        });

    // ----------------------------------------------------------
    // 4. FILE SAVE LIFECYCLE HOOK
    // ----------------------------------------------------------

    const saveListener =
        vscode.workspace.onDidSaveTextDocument((document) => {

            const uri = document.uri.toString();
            if (!isTrackableUri(uri)) return;

            if (!fileStateCache.has(uri)) {
                fileStateCache.set(uri, {
                    openedAt: Date.now(),
                    eventCount: 0,
                    lastEditAt: null
                });
            }

            const fileState = fileStateCache.get(uri)!;
            console.log('[Tracker] FILE SAVED:', uri);
            console.log('[Tracker] Persisting State:', JSON.stringify(fileState));

            // Stage 5: SQLite write goes here
        });

    // ----------------------------------------------------------
    // 5a. INLINE COMPLETION PROVIDER
    //     Only stamps timestamp — never returns suggestions.
    //     The 'skipped' log comes from OTHER providers (Copilot/
    //     Pylance). We cannot silence them, but we prefix our own
    //     logs so they are easy to filter.
    // ----------------------------------------------------------

    const inlineProvider =
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            {
                provideInlineCompletionItems(document, position) {

                    const uri = document.uri.toString();
                    if (!isTrackableUri(uri)) return { items: [] };

                    // Only stamp — do NOT log here to avoid per-keystroke noise
                    lastInlineCompletionTime = Date.now();
                    lastInlineCompletionUri = uri;

                    return { items: [] };
                }
            }
        );

    // ----------------------------------------------------------
    // 5b. ACCEPT SUGGESTION COMMAND INTERCEPTOR
    //     Wraps the built-in acceptSelectedSuggestion so we can
    //     mark the next edit on this file as AI_ACCEPTED with
    //     confidence 1.0 — as required by Stage 1 spec.
    // ----------------------------------------------------------

    const acceptInterceptor = vscode.commands.registerCommand(
        'editor.action.inlineSuggest.commit',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                lastInlineCompletionTime = Date.now();
                lastInlineCompletionUri = editor.document.uri.toString();
                console.log('[Tracker] AI SUGGESTION COMMITTED (confidence: 1.0) on',
                    lastInlineCompletionUri);
            }
            // Forward to VS Code's built-in handler
            await vscode.commands.executeCommand(
                'default:editor.action.inlineSuggest.commit'
            );
        }
    );

    // ----------------------------------------------------------
    // REGISTER ALL
    // ----------------------------------------------------------

    context.subscriptions.push(
        textChangeListener,
        selectionListener,
        openListener,
        saveListener,
        inlineProvider,
        acceptInterceptor,
    );
}

export function deactivate() {}