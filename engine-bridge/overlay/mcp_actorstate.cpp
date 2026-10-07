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
#include "d_event.h"
#include "d_player.h"
#include "doomstat.h"
#include "g_shared/a_pickups.h"
#include "menu/menu.h"
#include "r_state.h"
#include "r_data/sprites.h"
#include "m_fixed.h"
#include "tables.h"
#include <stdio.h>
#include <stdlib.h>

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
		FActorIterator it( atoi( argv[1] ) );
		mo = it.Next();
	}

	Printf( "MCP_ACTOR\n" );
	if ( mo == NULL ) { Printf( "actor none\n" ); return; }

	Printf( "class %s\n", mo->GetClass()->TypeName.GetChars() );
	Printf( "health %d\n", mo->health );
	Printf( "pos %.1f %.1f %.1f\n", FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ) );
	Printf( "angle %.1f\n", mo->angle / float( ANGLE_1 ) );
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
		"chat=%d demorec=%d pending=%d",
		token, paused, menu, console, gs,
		( mo != NULL ) ? ( dead ? "dead" : "alive" ) : "none",
		( mo != NULL && p->bSpectating ) ? 1 : 0,
		demoplayback ? 1 : 0,
		automapactive ? 1 : 0,
		( CHAT_GetChatMode() != CHATMODE_NONE ) ? 1 : 0,
		demorecording ? 1 : 0,
		// map/load/playdemo queue a gameaction for the next tic, so the rest of
		// this line still describes the state before it.
		MCP_LoadPending() ? 1 : 0 );

	// health/armor only mean something with a live player actor -- a menu or
	// intermission (mo == NULL) reads as gamestate=<not level>, not falsely "dead".
	if ( mo != NULL && n < sizeof( line ) )
	{
		AInventory *armor = mo->FindInventory<ABasicArmor>();
		n += (size_t)snprintf( line + n, sizeof( line ) - n, " health=%d armor=%d",
			mo->health, ( armor != NULL ) ? armor->Amount : 0 );
	}

	if ( menuactive != MENU_Off && DMenu::CurrentMenu != NULL && n < sizeof( line ) )
	{
		snprintf( line + n, sizeof( line ) - n, " menuclass=%s",
			DMenu::CurrentMenu->GetClass()->TypeName.GetChars() );
	}

	Printf( "%s\n", line );
}
