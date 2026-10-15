// ==== MCP_RUNACS (overlay-appended to p_acs.cpp; not committed upstream) ====
// Hot-load a compiled ACS object as a temporary module in the current level and
// optionally start one of its scripts (offline only; here for the file-static P_GetScriptGoing).
static int MCP_RunAcsSerial = 0;

static unsigned MCP_RunAcsModuleCount()
{
	unsigned n = 0;
	while ( FBehavior::StaticGetModule( n ) != NULL ) n++;
	return n;
}

// mcp_runacs <path> [script] [args...] [open=1]
// Reply: MCP_RUNACS module=<index> scripts=<n> started=<script|none> deferred=<0|1>
// deferred=1 means the snippet holds DEATH/ENTER/RESPAWN/... scripts that fire later.
CCMD( mcp_runacs )
{
	if ( argv.argc() < 2 ) { Printf( "error usage: mcp_runacs <path> [script] [args...] [open=1]\n" ); return; }
	if ( NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode() ) { Printf( "error netgame\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }

	bool open = false;
	const char *script = NULL;
	int args[4] = { 0, 0, 0, 0 };
	int nargs = 0;
	for ( int i = 2; i < argv.argc(); i++ )
	{
		if ( strcmp( argv[i], "open=1" ) == 0 ) open = true;
		else if ( script == NULL ) script = argv[i];
		else if ( nargs < 4 ) args[nargs++] = atoi( argv[i] );
		else { Printf( "error at most 4 script args\n" ); return; }
	}
	int num = 0;
	if ( script != NULL )
	{
		char *end;
		long v = strtol( script, &end, 10 );
		// A non-numeric script is a named one, numbered the way ACS names are.
		num = ( *end == 0 ) ? (int)v : -FName( script );
	}

	FileReader fr;
	if ( !fr.Open( argv[1] ) ) { Printf( "error cannot open %s\n", argv[1] ); return; }

	unsigned before = MCP_RunAcsModuleCount();
	// A fresh LumpNum <= -2 (what mcp_status counts as acstemp=), since StaticLoadModule
	// returns any module whose LumpNum matches and the map's own BEHAVIOR is -1.
	FBehavior *b = new FBehavior( -2 - MCP_RunAcsSerial++, &fr, (int)fr.GetLength() );
	// Every refusal below leaves an inert module loaded until the map changes: the
	// constructor registers it before validating, and StaticModules is private.
	if ( MCP_RunAcsModuleCount() != before + 1 )
	{
		Printf( "error imports a library that is not loaded in this level (modules left loaded until the map changes)\n" );
		return;
	}
	if ( !b->IsGood() )
	{
		Printf( "error bad module (not an ACS object, unresolved import or import mismatch; inert module %u left loaded)\n", before );
		return;
	}

	const ScriptPtr *code = NULL;
	if ( script != NULL && ( code = b->FindScript( num ) ) == NULL )
	{
		Printf( "error no script %s in the snippet (module %u left loaded, unstarted)\n", script, before );
		return;
	}

	int nscripts = 0;
	bool deferred = false;
	for ( const ScriptPtr *p; ( p = b->GetScriptPtr( nscripts ) ) != NULL; nscripts++ )
	{
		if ( p->Type != SCRIPT_Closed && p->Type != SCRIPT_Open ) deferred = true;
	}

	// Run inside this call (as runNow does) so Log() lands in the reply; offline the
	// console player is never predicted, so no unpredict is needed.
	AActor *activator = playeringame[consoleplayer] ? players[consoleplayer].mo : NULL;
	if ( open ) b->StartTypedScripts( SCRIPT_Open, NULL, false, 0, true );
	if ( code != NULL )
	{
		DLevelScript *s = P_GetScriptGoing( activator, NULL, num, code, b, args, nargs, ACS_ALWAYS );
		if ( s != NULL ) s->RunScript();
	}

	Printf( "MCP_RUNACS module=%u scripts=%d started=%s deferred=%d\n",
		before, nscripts, script != NULL ? script : "none", deferred ? 1 : 0 );
}
// ==== end MCP_RUNACS ====
