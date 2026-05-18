import * as vscode from 'vscode';

interface RawEditEvent {
    uri: string;
    changes: readonly vscode.TextDocumentContentChangeEvent[];
    timestamp: number;
    source: string;
}

const fileStateCache = new Map<string, any>();

export function activate(context: vscode.ExtensionContext) {

    console.log('Human vs AI Tracker Activated');

    /*
    =====================================================
    1. PASSIVE DOCUMENT OBSERVER
    =====================================================
    */

    const textChangeListener =
        vscode.workspace.onDidChangeTextDocument(async (event) => {

            let source = 'TYPING';

            const changes = event.contentChanges;

            /*
            ============================================
            CLIPBOARD ANALYZER
            ============================================
            */

            for (const change of changes) {

                if (change.text.length >= 20) {

                    try {

                        const clipboardText =
                            await vscode.env.clipboard.readText();

                        if (
                            clipboardText.trim() === change.text.trim()
                        ) {
                            source = 'PASTE';
                        }

                    } catch (err) {
                        console.error('Clipboard Read Error:', err);
                    }
                }
            }

            /*
            ============================================
            RAW EVENT CREATION
            ============================================
            */

            const rawEvent: RawEditEvent = {
                uri: event.document.uri.toString(),
                changes: changes,
                timestamp: Date.now(),
                source: source
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
                eventCount: 0
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

            console.log('FILE SAVED:', uri);

            /*
            DATABASE PERSISTENCE PLACEHOLDER
            */

            const fileState = fileStateCache.get(uri);

            console.log('Persisting State:', fileState);
        });

    /*
    =====================================================
    5. INLINE AI COMPLETION PROVIDER
    =====================================================
    */

    const inlineProvider =
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },

            {
                async provideInlineCompletionItems(document, position) {

                    console.log('INLINE COMPLETION TRIGGERED');

                    /*
                    This is where future AI interception logic goes.
                    */

                    return [];
                }
            }
        );

    /*
    =====================================================
    6. AI ACCEPT SUGGESTION INTERCEPT
    =====================================================
    */

    const commandInterceptor =
        vscode.commands.registerCommand(
            'human-ai-code-tracker.acceptSuggestion',
            async () => {

                console.log('AI SUGGESTION ACCEPTED');

                const editor = vscode.window.activeTextEditor;

                if (!editor) {
                    return;
                }

                const rawEvent: RawEditEvent = {
                    uri: editor.document.uri.toString(),
                    changes: [],
                    timestamp: Date.now(),
                    source: 'AI_ACCEPTED'
                };

                console.log('AI ACCEPT EVENT:', rawEvent);
            });

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
        commandInterceptor
    );
}

export function deactivate() {}