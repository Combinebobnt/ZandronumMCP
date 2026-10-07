//
// mcp_actorstate.cpp -- read-only DECORATE/actor state inspection (overlay file).
// Dumps an actor's live state: class, health, position, current DECORATE state
// (sprite/frame/tics, e.g. "TNT1 A 0"), inventory chain, and -- for players --
// ready weapon and morph status. Plus the actors near the player. All reads.
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "c_console.h"
#include "actor.h"
#include "chat.h"
#include "am_map.h"
#include "d_event.h"
#include "d_player.h"
#include "doomstat.h"
#include "g_shared/a_pickups.h"
#include "menu/menu.h"
#include "r_state.h"
#include "r_data/sprites.h"
#include "m_fixed.h"
#include "tables.h"
#include "g_level.h"
#include "r_utility.h"
#include "v_text.h"
#include "network.h"
#include "sv_commands.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void MCP_PrintState( const char *label, AActor *mo )
{
	if ( mo->state != NULL && mo->state->sprite < sprites.Size() )
	{
		Printf( "%s %s %c %d\n", label, sprites[mo->state->sprite].name,
			(char)( 'A' + mo->state->Frame ), mo->state->Tics );
	}
}

CCMD( dumpactor )
{
	AActor *mo = players[consoleplayer].mo;
	if ( argv.argc() >= 2 )
	{
		// Optional second arg picks the nth (0-based) actor sharing the TID.
		FActorIterator it( atoi( argv[1] ) );
		int skip = ( argv.argc() >= 3 ) ? atoi( argv[2] ) : 0;
		mo = it.Next();
		for ( int i = 0; i < skip && mo != NULL; i++ ) mo = it.Next();
	}

	Printf( "MCP_ACTOR\n" );
	if ( mo == NULL ) { Printf( "actor none\n" ); return; }

	Printf( "class %s\n", mo->GetClass()->TypeName.GetChars() );
	Printf( "health %d\n", mo->health );
	Printf( "pos %.1f %.1f %.1f\n", FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ) );
	Printf( "angle %.1f\n", mo->angle / float( ANGLE_1 ) );
	Printf( "pitch %.1f\n", mo->pitch / float( ANGLE_1 ) );
	MCP_PrintState( "state", mo );

	if ( mo->player != NULL )
	{
		if ( mo->player->ReadyWeapon != NULL )
			Printf( "weapon %s\n", mo->player->ReadyWeapon->GetClass()->TypeName.GetChars() );
		Printf( "morphtics %d\n", mo->player->morphTics );
	}

	for ( AInventory *item = mo->Inventory; item != NULL; item = item->Inventory )
		Printf( "item %s %d %d\n", item->GetClass()->TypeName.GetChars(), item->Amount, item->MaxAmount );
}

CCMD( actorsnear )
{
	AActor *me = players[consoleplayer].mo;
	Printf( "MCP_ACTORS\n" );
	if ( me == NULL ) return;
	fixed_t r = ( ( argv.argc() >= 2 ) ? atoi( argv[1] ) : 512 ) * FRACUNIT;

	TThinkerIterator<AActor> it;
	AActor *a;
	while ( ( a = it.Next() ) != NULL )
	{
		if ( a == me ) continue;
		if ( abs( a->x - me->x ) > r || abs( a->y - me->y ) > r ) continue;
		const char *spr = ( a->state != NULL && a->state->sprite < sprites.Size() )
			? sprites[a->state->sprite].name : "----";
		Printf( "near %s %d %.0f %.0f %s\n", a->GetClass()->TypeName.GetChars(), a->health,
			FIXED2FLOAT( a->x ), FIXED2FLOAT( a->y ), spr );
	}
}

// Only the queued actions that load a map, save or demo; screenshot, automap,
// autosave and the like also pass through gameaction but change nothing visible.
static bool MCP_LoadPending( )
{
	switch ( gameaction )
	{
		case ga_loadlevel:
		case ga_newgame:
		case ga_newgame2:
		case ga_loadgame:
		case ga_loadgamehidecon:
		case ga_loadgameplaydemo:
		case ga_autoloadgame:
		case ga_playdemo:
			return true;
		default:
			return false;
	}
}

// One-line engine state snapshot, so an MCP caller can tell a normally-running
// game apart from paused/menu/console/intermission/dead/spectating/chatting/
// demo-recording states that would otherwise make an unrelated tool (summon,
// menu_key, screenshot) look like it succeeded while doing nothing. With an
// argument, that argument is
// echoed as the leading token (the sentinel-riding form used by the bridge);
// with none, "MCP_STATUS" is used instead, so the command stays usable by hand.
CCMD( mcp_status )
{
	const char *token = ( argv.argc() >= 2 ) ? argv[1] : "MCP_STATUS";

	const char *menu = "off";
	if ( menuactive == MENU_On ) menu = "on";
	else if ( menuactive == MENU_WaitKey ) menu = "waitkey";
	else if ( menuactive == MENU_OnNoPause ) menu = "onnopause";

	const char *console = "up";
	if ( ConsoleState == c_down ) console = "down";
	else if ( ConsoleState == c_falling ) console = "falling";
	else if ( ConsoleState == c_rising ) console = "rising";

	const char *gs = "level";
	switch ( gamestate )
	{
		case GS_INTERMISSION: gs = "intermission"; break;
		case GS_FINALE:       gs = "finale";       break;
		case GS_DEMOSCREEN:   gs = "demoscreen";   break;
		case GS_FULLCONSOLE:  gs = "fullconsole";  break;
		case GS_HIDECONSOLE:  gs = "hideconsole";  break;
		case GS_STARTUP:      gs = "startup";      break;
		case GS_TITLELEVEL:   gs = "titlelevel";   break;
		default: break; // GS_LEVEL
	}

	player_t *p = playeringame[consoleplayer] ? &players[consoleplayer] : NULL;
	AActor *mo = ( p != NULL ) ? p->mo : NULL;
	bool dead = ( mo != NULL ) && ( ( p->playerstate == PST_DEAD ) || ( mo->health <= 0 ) );

	char line[512];
	size_t n = (size_t)snprintf( line, sizeof( line ),
		"%s paused=%d menu=%s console=%s gamestate=%s player=%s spectating=%d demo=%d automap=%d "
		"chat=%d demorec=%d pending=%d maptime=%d",
		token, paused, menu, console, gs,
		( mo != NULL ) ? ( dead ? "dead" : "alive" ) : "none",
		( mo != NULL && p->bSpectating ) ? 1 : 0,
		demoplayback ? 1 : 0,
		automapactive ? 1 : 0,
		( CHAT_GetChatMode() != CHATMODE_NONE ) ? 1 : 0,
		demorecording ? 1 : 0,
		// map/load/playdemo queue a gameaction for the next tic, so the rest of
		// this line still describes the state before it.
		MCP_LoadPending() ? 1 : 0,
		level.maptime );

	// health/armor only mean something with a live player actor -- a menu or
	// intermission (mo == NULL) reads as gamestate=<not level>, not falsely "dead".
	if ( mo != NULL && n < sizeof( line ) )
	{
		AInventory *armor = mo->FindInventory<ABasicArmor>();
		n += (size_t)snprintf( line + n, sizeof( line ) - n, " health=%d armor=%d cheats=%d",
			mo->health, ( armor != NULL ) ? armor->Amount : 0, p->cheats );
	}

	if ( menuactive != MENU_Off && DMenu::CurrentMenu != NULL && n < sizeof( line ) )
	{
		snprintf( line + n, sizeof( line ) - n, " menuclass=%s",
			DMenu::CurrentMenu->GetClass()->TypeName.GetChars() );
	}

	Printf( "%s\n", line );
}

// --- test-session CCMDs: mcp_setview / dumpplayers / findactors / mcp_spawnat
// Listing output is "<tag> key=value ..." with name= always last (names can
// hold spaces), so a caller parses every line with one generic key=value reader.

static double MCP_Deg( int bam ) { return bam / double( ANGLE_1 ); }

// An actor reference as "player<n>" for a player body, else "Class#tid".
static FString MCP_ActorRef( AActor *a )
{
	FString s;
	if ( a->player != NULL ) s.Format( "player%d", int( a->player - players ) );
	else s.Format( "%s#%d", a->GetClass()->TypeName.GetChars(), a->tid );
	return s;
}

// Owned inventory rides its owner around the map; it isn't a map actor.
static bool MCP_IsOwnedItem( AActor *a )
{
	return a->IsKindOf( RUNTIME_CLASS( AInventory ) ) && static_cast<AInventory *>( a )->Owner != NULL;
}

static double MCP_Dist2D( AActor *a, AActor *b )
{
	double dx = FIXED2FLOAT( a->x ) - FIXED2FLOAT( b->x );
	double dy = FIXED2FLOAT( a->y ) - FIXED2FLOAT( b->y );
	return sqrt( dx * dx + dy * dy );
}

// Parses "key=N" out of argv; returns false if no such key was given.
static bool MCP_IntArg( FCommandLine &argv, const char *key, int &out )
{
	size_t len = strlen( key );
	for ( int i = 1; i < argv.argc(); i++ )
	{
		if ( strncmp( argv[i], key, len ) == 0 && argv[i][len] == '=' )
		{
			out = atoi( argv[i] + len + 1 );
			return true;
		}
	}
	return false;
}

static const char *MCP_StrArg( FCommandLine &argv, const char *key )
{
	size_t len = strlen( key );
	for ( int i = 1; i < argv.argc(); i++ )
		if ( strncmp( argv[i], key, len ) == 0 && argv[i][len] == '=' ) return argv[i] + len + 1;
	return NULL;
}

// Parses "key=N" as a fractional number; returns false if the key is absent.
static bool MCP_NumArg( FCommandLine &argv, const char *key, double &out )
{
	const char *v = MCP_StrArg( argv, key );
	if ( v == NULL ) return false;
	out = atof( v );
	return true;
}

// The field head shared by findactors' found line and mcp_spawnat's spawned line.
static void MCP_AppendActorKv( FString &line, AActor *a )
{
	line.AppendFormat( "class=%s tid=%d hp=%d spawnhp=%d x=%.1f y=%.1f z=%.1f angle=%.1f pitch=%.1f",
		a->GetClass()->TypeName.GetChars(), a->tid, a->health, a->SpawnHealth(),
		FIXED2FLOAT( a->x ), FIXED2FLOAT( a->y ), FIXED2FLOAT( a->z ),
		a->angle / double( ANGLE_1 ), MCP_Deg( a->pitch ) );
}

// mcp_setview <deg> [pitch] | mcp_setview tid=N | mcp_setview class=X
// Pitch is in the engine's convention: negative looks up.
CCMD( mcp_setview )
{
	AActor *me = players[consoleplayer].mo;
	if ( me == NULL || me->player == NULL ) { Printf( "error no player\n" ); return; }
	if ( argv.argc() < 2 ) { Printf( "error usage: mcp_setview <deg> [pitch] | tid=N | class=X\n" ); return; }

	AActor *target = NULL;
	int tid;
	const char *cls = MCP_StrArg( argv, "class" );
	double yawDeg, pitchDeg;

	if ( MCP_IntArg( argv, "tid", tid ) )
	{
		FActorIterator it( tid );
		target = it.Next();
		if ( target == NULL ) { Printf( "error no actor with tid %d\n", tid ); return; }
	}
	else if ( cls != NULL )
	{
		const PClass *type = PClass::FindClass( cls );
		if ( type == NULL ) { Printf( "error unknown class %s\n", cls ); return; }
		TThinkerIterator<AActor> it;
		AActor *a;
		double best = 0;
		while ( ( a = it.Next() ) != NULL )
		{
			if ( a == me || !a->IsKindOf( type ) || MCP_IsOwnedItem( a ) ) continue;
			double d = MCP_Dist2D( me, a );
			if ( target == NULL || d < best ) { target = a; best = d; }
		}
		if ( target == NULL ) { Printf( "error no %s on the map\n", cls ); return; }
	}
	else
	{
		yawDeg = atof( argv[1] );
		pitchDeg = ( argv.argc() >= 3 ) ? atof( argv[2] ) : MCP_Deg( me->pitch );
	}

	if ( target != NULL )
	{
		yawDeg = MCP_Deg( int( R_PointToAngle2( me->x, me->y, target->x, target->y ) ) );
		double eye = FIXED2FLOAT( me->z ) + FIXED2FLOAT( me->player->viewheight );
		double dz = FIXED2FLOAT( target->z ) + FIXED2FLOAT( target->height ) / 2 - eye;
		pitchDeg = -atan2( dz, MCP_Dist2D( me, target ) ) * 180.0 / M_PI;
	}

	yawDeg = fmod( yawDeg, 360.0 );
	if ( yawDeg < 0 ) yawDeg += 360.0;
	if ( pitchDeg > 89.0 ) pitchDeg = 89.0;
	if ( pitchDeg < -89.0 ) pitchDeg = -89.0;

	me->SetAngle( angle_t( yawDeg * double( ANGLE_1 ) ), false );
	me->SetPitch( int( pitchDeg * double( ANGLE_1 ) ), false );
	if ( NETWORK_GetState() == NETSTATE_SERVER )
	{
		SERVERCOMMANDS_SetThingAngleExact( me );
		SERVERCOMMANDS_MoveThingExact( me, CM_PITCH );
	}

	FString line;
	line.Format( "view angle=%.1f pitch=%.1f", me->angle / double( ANGLE_1 ), MCP_Deg( me->pitch ) );
	if ( target != NULL )
		line.AppendFormat( " tid=%d class=%s", target->tid, target->GetClass()->TypeName.GetChars() );
	Printf( "%s\n", line.GetChars() );
}

// Clears what eats input without a stock CCMD to close it: console, chat, automap.
// The menu has `closemenu`; the pause flag has the bridge's setpause message.
CCMD( mcp_unblock )
{
	C_HideConsole();
	if ( CHAT_GetChatMode() != CHATMODE_NONE ) CHAT_SetChatMode( CHATMODE_NONE );
	if ( automapactive ) AM_Stop();
	Printf( "unblock ok\n" );
}

CCMD( dumpplayers )
{
	static const char *const STATES[] = { "live", "dead", "reborn", "enter", "reborn", "enter" };
	Printf( "MCP_PLAYERS\n" );
	for ( int i = 0; i < MAXPLAYERS; i++ )
	{
		if ( !playeringame[i] ) continue;
		player_t *p = &players[i];
		FString line;
		line.Format( "player slot=%d bot=%d spec=%d deadspec=%d", i, p->bIsBot ? 1 : 0,
			p->bSpectating ? 1 : 0, p->bDeadSpectator ? 1 : 0 );
		if ( unsigned( p->playerstate ) < countof( STATES ) )
			line.AppendFormat( " state=%s", STATES[p->playerstate] );

		AActor *mo = p->mo;
		if ( mo != NULL )
		{
			AInventory *armor = mo->FindInventory<ABasicArmor>();
			line.AppendFormat( " hp=%d armor=%d", mo->health, ( armor != NULL ) ? armor->Amount : 0 );
			if ( p->ReadyWeapon != NULL )
				line.AppendFormat( " weapon=%s", p->ReadyWeapon->GetClass()->TypeName.GetChars() );
			line.AppendFormat( " x=%.1f y=%.1f z=%.1f angle=%.1f pitch=%.1f tid=%d",
				FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ),
				mo->angle / double( ANGLE_1 ), MCP_Deg( mo->pitch ), mo->tid );
		}
		line.AppendFormat( " cheats=%d frags=%d deaths=%u kills=%d items=%d secrets=%d points=%d wins=%u",
			p->cheats, p->fragcount, (unsigned)p->ulDeathCount, p->killcount, p->itemcount,
			p->secretcount, (int)p->lPointCount, (unsigned)p->ulWins );
		if ( p->bOnTeam ) line.AppendFormat( " team=%u", p->Team );
		line.AppendFormat( " ping=%u", (unsigned)p->ulPing );

		FString name = p->userinfo.GetName();
		V_RemoveColorCodes( name );
		line.AppendFormat( " name=%s", name.GetChars() );
		Printf( "%s\n", line.GetChars() );
	}
}

// Letter set for findactors' flags= field; mirrored by FLAG_LETTERS in
// src/parsers/actorstate.ts.
static FString MCP_FlagLetters( AActor *a )
{
	FString f;
	if ( a->flags3 & MF3_ISMONSTER ) f += 'm';
	if ( a->flags & MF_FRIENDLY ) f += 'f';
	if ( a->flags & MF_CORPSE ) f += 'c';
	if ( a->flags2 & MF2_DORMANT ) f += 'd';
	if ( a->flags & MF_SHOOTABLE ) f += 's';
	if ( a->flags & MF_SOLID ) f += 'o';
	if ( ( a->flags2 & MF2_INVULNERABLE ) || ( a->flags5 & MF5_NODAMAGE ) ) f += 'i';
	if ( a->flags & MF_AMBUSH ) f += 'a';
	if ( f.IsEmpty() ) f = "-";
	return f;
}

// index: the actor's position in the TID's FActorIterator walk, as dumpactor counts it.
struct MCPFound { AActor *actor; double dist; int index; };

static int MCP_CompareFound( const void *a, const void *b )
{
	double da = static_cast<const MCPFound *>( a )->dist, db = static_cast<const MCPFound *>( b )->dist;
	return ( da < db ) ? -1 : ( da > db ) ? 1 : 0;
}

// findactors [class=X] [tid=N] [radius=N] [limit=N] [detail=1]
CCMD( findactors )
{
	Printf( "MCP_FOUND\n" );
	AActor *me = players[consoleplayer].mo;
	const char *cls = MCP_StrArg( argv, "class" );
	const PClass *type = NULL;
	if ( cls != NULL )
	{
		type = PClass::FindClass( cls );
		if ( type == NULL ) { Printf( "error unknown class %s\n", cls ); return; }
	}
	int tid = 0, radius = 0, limit = 200, detail = 0;
	bool byTid = MCP_IntArg( argv, "tid", tid );
	bool byRadius = MCP_IntArg( argv, "radius", radius ) && me != NULL;
	MCP_IntArg( argv, "limit", limit );
	MCP_IntArg( argv, "detail", detail );

	TArray<MCPFound> hits;
	TThinkerIterator<AActor> all;
	FActorIterator tagged( tid );
	for ( int walked = 0;; walked++ )
	{
		AActor *a = byTid ? tagged.Next() : all.Next();
		if ( a == NULL ) break;
		if ( MCP_IsOwnedItem( a ) ) continue;
		if ( type != NULL && !a->IsKindOf( type ) ) continue;
		MCPFound hit = { a, ( me != NULL ) ? MCP_Dist2D( me, a ) : 0.0, walked };
		if ( byRadius && hit.dist > radius ) continue;
		hits.Push( hit );
	}
	if ( me != NULL && hits.Size() > 1 )
		qsort( &hits[0], hits.Size(), sizeof( MCPFound ), MCP_CompareFound );

	unsigned shown = ( limit > 0 && unsigned( limit ) < hits.Size() ) ? unsigned( limit ) : hits.Size();
	for ( unsigned i = 0; i < shown; i++ )
	{
		AActor *a = hits[i].actor;
		FString line = "found ";
		MCP_AppendActorKv( line, a );
		if ( me != NULL ) line.AppendFormat( " dist=%.1f", hits[i].dist );
		if ( byTid ) line.AppendFormat( " index=%d", hits[i].index );
		if ( a->state != NULL && a->state->sprite < sprites.Size() )
			line.AppendFormat( " sprite=%s frame=%c", sprites[a->state->sprite].name,
				(char)( 'A' + a->state->Frame ) );
		line.AppendFormat( " flags=%s", MCP_FlagLetters( a ).GetChars() );
		if ( a->target != NULL ) line.AppendFormat( " target=%s", MCP_ActorRef( a->target ).GetChars() );
		if ( detail )
		{
			if ( a->master != NULL ) line.AppendFormat( " master=%s", MCP_ActorRef( a->master ).GetChars() );
			if ( a->tracer != NULL ) line.AppendFormat( " tracer=%s", MCP_ActorRef( a->tracer ).GetChars() );
			line.AppendFormat( " special=%d args=%d,%d,%d,%d,%d", a->special,
				a->args[0], a->args[1], a->args[2], a->args[3], a->args[4] );
			line.AppendFormat( " vel=%.2f,%.2f,%.2f radius=%.1f height=%.1f floorz=%.1f",
				FIXED2FLOAT( a->velx ), FIXED2FLOAT( a->vely ), FIXED2FLOAT( a->velz ),
				FIXED2FLOAT( a->radius ), FIXED2FLOAT( a->height ), FIXED2FLOAT( a->floorz ) );
			if ( a->player != NULL ) line.AppendFormat( " player=%d", int( a->player - players ) );
		}
		Printf( "%s\n", line.GetChars() );
	}
	if ( shown < hits.Size() ) Printf( "truncated shown=%u total=%u\n", shown, hits.Size() );
}

// Strict number parse, so "x=abc" is a usage error rather than a silent 0.
static bool MCP_ParseNum( const char *s, double &out )
{
	char *end;
	out = strtod( s, &end );
	return end != s && *end == '\0' && isfinite( out );
}

// A map coordinate FLOAT2FIXED can hold; 16.16 fixed point wraps outside it.
static bool MCP_InFixedRange( double v )
{
	return v >= -32768.0 && v <= 32767.0;
}

// Why P_TestMobjLocation refused: an actor, a line, or a floor/ceiling fit.
static FString MCP_BlockReason( AActor *a )
{
	FString s;
	if ( a->BlockingMobj != NULL ) s.Format( "blocked by %s", MCP_ActorRef( a->BlockingMobj ).GetChars() );
	else if ( a->BlockingLine != NULL ) s.Format( "blocked by line %d", int( a->BlockingLine - lines ) );
	else s.Format( "blocked floor=%.1f ceiling=%.1f z=%.1f height=%.1f", FIXED2FLOAT( a->floorz ),
		FIXED2FLOAT( a->ceilingz ), FIXED2FLOAT( a->z ), FIXED2FLOAT( a->height ) );
	return s;
}

// mcp_spawnat <class> <x> <y> [z=N] [angle=N] [tid=N|auto] [kind=friend|foe] [force=1]
//   [health=N] [special=N] [args=a,b,c,d,e] [ambush=1] [dormant=1]
// Spawns directly (no net command), so the reply reports the new actor. z defaults
// to the floor, angle is in degrees, tid defaults to a fresh unique TID.
CCMD( mcp_spawnat )
{
	static const char *const USAGE = "error usage: mcp_spawnat <class> <x> <y> [z=N] [angle=N] "
		"[tid=N|auto] [kind=friend|foe] [force=1] [health=N] [special=N] [args=a,b,c,d,e] "
		"[ambush=1] [dormant=1]\n";
	double x, y, z = 0, angle = 0;
	if ( argv.argc() < 4 || strchr( argv[1], '=' ) != NULL || !MCP_ParseNum( argv[2], x ) ||
		!MCP_ParseNum( argv[3], y ) ) { Printf( "%s", USAGE ); return; }
	if ( NETWORK_InClientMode() ) { Printf( "error client: spawn on the server instance\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }

	const PClass *type = PClass::FindClass( argv[1] );
	if ( type == NULL || type->ActorInfo == NULL ) { Printf( "error unknown class %s\n", argv[1] ); return; }

	bool hasZ = MCP_NumArg( argv, "z", z );
	MCP_NumArg( argv, "angle", angle );
	if ( !MCP_InFixedRange( x ) || !MCP_InFixedRange( y ) || !MCP_InFixedRange( z ) )
	{
		Printf( "error coordinates must be within -32768..32767\n" );
		return;
	}
	const char *tidArg = MCP_StrArg( argv, "tid" );
	const char *kind = MCP_StrArg( argv, "kind" );
	const char *argsArg = MCP_StrArg( argv, "args" );
	int force = 0, health = 0, special = 0, ambush = 0, dormant = 0;
	MCP_IntArg( argv, "force", force );
	bool hasHealth = MCP_IntArg( argv, "health", health );
	bool hasSpecial = MCP_IntArg( argv, "special", special );
	MCP_IntArg( argv, "ambush", ambush );
	MCP_IntArg( argv, "dormant", dormant );
	bool friendKind = kind != NULL && strcmp( kind, "friend" ) == 0;
	bool foeKind = kind != NULL && strcmp( kind, "foe" ) == 0;
	if ( kind != NULL && !friendKind && !foeKind ) { Printf( "%s", USAGE ); return; }

	int args[5] = { 0, 0, 0, 0, 0 };
	if ( argsArg != NULL )
	{
		const char *p = argsArg;
		for ( int i = 0; i < 5 && *p != '\0'; i++ )
		{
			args[i] = atoi( p );
			p = strchr( p, ',' );
			if ( p == NULL ) break;
			p++;
		}
	}

	AActor *actor = Spawn( type, FLOAT2FIXED( x ), FLOAT2FIXED( y ), hasZ ? FLOAT2FIXED( z ) : ONFLOORZ,
		ALLOW_REPLACE );
	if ( actor == NULL ) { Printf( "error spawn failed\n" ); return; }

	if ( !force )
	{
		DWORD oldFlags2 = actor->flags2;
		actor->flags2 |= MF2_PASSMOBJ;
		bool ok = P_TestMobjLocation( actor );
		actor->flags2 = oldFlags2;
		if ( !ok )
		{
			FString why = MCP_BlockReason( actor );
			actor->ClearCounters();
			actor->Destroy();
			Printf( "error %s\n", why.GetChars() );
			return;
		}
	}

	angle = fmod( angle, 360.0 );
	if ( angle < 0 ) angle += 360.0;
	actor->angle = angle_t( angle * double( ANGLE_1 ) );
	actor->tid = ( tidArg == NULL || strcmp( tidArg, "auto" ) == 0 ) ? P_FindUniqueTID( 0, 0 ) : atoi( tidArg );
	if ( actor->tid != 0 ) actor->AddToHash();
	if ( actor->flags & MF_SPECIAL ) actor->flags |= MF_DROPPED;

	if ( friendKind )
	{
		if ( actor->CountsAsKill() ) level.total_monsters--;
		actor->FriendPlayer = consoleplayer + 1;
		actor->flags |= MF_FRIENDLY;
		actor->LastHeard = players[consoleplayer].mo;
		actor->health = actor->SpawnHealth();
	}
	else if ( foeKind )
	{
		actor->FriendPlayer = 0;
		actor->flags &= ~MF_FRIENDLY;
		actor->health = actor->SpawnHealth();
	}
	if ( hasHealth ) actor->health = health;
	if ( hasSpecial )
	{
		actor->special = special;
		for ( int i = 0; i < 5; i++ ) actor->args[i] = args[i];
	}
	// Direct writes rather than HandleSpawnFlags, which also resets InitialState.
	if ( ambush ) actor->flags |= MF_AMBUSH;
	if ( dormant ) actor->Deactivate( NULL );

	if ( NETWORK_GetState() == NETSTATE_SERVER )
	{
		SERVERCOMMANDS_SpawnThing( actor );
		if ( actor->angle != 0 ) SERVERCOMMANDS_SetThingAngle( actor );
		if ( actor->tid != 0 ) SERVERCOMMANDS_SetThingTID( actor );
		if ( kind != NULL || ambush ) SERVERCOMMANDS_SetThingFlags( actor, FLAGSET_FLAGS );
		if ( kind != NULL || hasHealth ) SERVERCOMMANDS_SetThingHealth( actor );
		if ( hasSpecial ) { SERVERCOMMANDS_SetThingSpecial( actor ); SERVERCOMMANDS_SetThingArguments( actor ); }
		if ( dormant ) SERVERCOMMANDS_ThingDeactivate( actor, NULL );
		SERVER_DestroyActorIfClientsidedOnly( actor );
	}

	FString line = "spawned ";
	MCP_AppendActorKv( line, actor );
	line.AppendFormat( " flags=%s", MCP_FlagLetters( actor ).GetChars() );
	if ( stricmp( actor->GetClass()->TypeName.GetChars(), argv[1] ) != 0 ) line.AppendFormat( " requested=%s", argv[1] );
	if ( hasSpecial )
		line.AppendFormat( " special=%d args=%d,%d,%d,%d,%d", actor->special,
			actor->args[0], actor->args[1], actor->args[2], actor->args[3], actor->args[4] );
	if ( force ) line += " forced=1";
	Printf( "%s\n", line.GetChars() );
}
