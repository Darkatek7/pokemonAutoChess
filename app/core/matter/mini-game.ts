import { MapSchema } from "@colyseus/schema"
import {
  Bodies,
  Body,
  Composite,
  Constraint,
  Engine,
  Events,
  Vector
} from "matter-js"
import { FloatingItem } from "../../models/colyseus-models/floating-item"
import Player from "../../models/colyseus-models/player"
import { PokemonAvatarModel } from "../../models/colyseus-models/pokemon-avatar"
import { Portal, SynergySymbol } from "../../models/colyseus-models/portal"
import { getOrientation } from "../../utils/orientation"
import GameRoom from "../../rooms/game-room"
import GameState from "../../rooms/states/game-state"
import { Transfer } from "../../types"
import {
  ItemCarouselStages,
  KECLEON_SHOP_COST,
  PortalCarouselStages,
  SynergyTriggers
} from "../../types/Config"
import { DungeonDetails, DungeonPMDO } from "../../types/enum/Dungeon"
import { PokemonActionState } from "../../types/enum/Game"
import {
  CraftableItems,
  Item,
  ItemComponents,
  SynergyStones
} from "../../types/enum/Item"
import { SpecialGameRule } from "../../types/enum/SpecialGameRule"
import { Synergy } from "../../types/enum/Synergy"
import { clamp, min } from "../../utils/number"
import {
  pickNRandomIn,
  pickRandomIn,
  randomBetween,
  shuffleArray
} from "../../utils/random"
import { keys, values } from "../../utils/schemas"

const PLAYER_VELOCITY = 2
const ITEM_ROTATION_SPEED = 0.0004
const PORTAL_ROTATION_SPEED = 0.0003
const SYMBOL_ROTATION_SPEED = 0.0006
const CAROUSEL_RADIUS = 150
const NB_SYMBOLS_PER_PLAYER = 4

export class MiniGame {
  avatars: MapSchema<PokemonAvatarModel> | undefined
  items: MapSchema<FloatingItem> | undefined
  portals: MapSchema<Portal> | undefined
  symbols: MapSchema<SynergySymbol> | undefined
  symbolsByPortal: Map<string, SynergySymbol[]> = new Map()
  bodies: Map<string, Body>
  alivePlayers: Player[]
  engine: Engine
  centerX: number = 325
  centerY: number = 250

  constructor(room: GameRoom) {
    this.engine = Engine.create({ gravity: { x: 0, y: 0 } })
    this.bodies = new Map<string, Body>()
    this.alivePlayers = []
    Composite.add(
      this.engine.world,
      Bodies.rectangle(0, -70, 2000, 40, { isStatic: true, restitution: 1 })
    )
    Composite.add(
      this.engine.world,
      Bodies.rectangle(-70, 0, 40, 2000, { isStatic: true, restitution: 1 })
    )
    Composite.add(
      this.engine.world,
      Bodies.rectangle(740, 0, 40, 2000, { isStatic: true, restitution: 1 })
    )
    Composite.add(
      this.engine.world,
      Bodies.rectangle(0, 610, 2000, 40, { isStatic: true, restitution: 1 })
    )
    Events.on(this.engine, "beforeUpdate", () => {
      this.items?.forEach((item) => {
        if (item.avatarId === "") {
          const itemBody = this.bodies.get(item.id)
          if (itemBody) {
            const t = this.engine.timing.timestamp * ITEM_ROTATION_SPEED
            const x =
              this.centerX +
              Math.cos(t + (Math.PI * 2 * item.index) / this.items!.size) *
                CAROUSEL_RADIUS
            const y =
              this.centerY +
              Math.sin(t + (Math.PI * 2 * item.index) / this.items!.size) *
                CAROUSEL_RADIUS
            Body.setPosition(itemBody, { x, y })
          }
        }
      })

      this.portals?.forEach((portal) => {
        if (portal.avatarId === "") {
          const portalBody = this.bodies.get(portal.id)
          if (portalBody) {
            const t = this.engine.timing.timestamp * PORTAL_ROTATION_SPEED
            const x =
              this.centerX +
              Math.cos(t + (Math.PI * 2 * portal.index) / this.portals!.size) *
                CAROUSEL_RADIUS
            const y =
              this.centerY +
              Math.sin(t + (Math.PI * 2 * portal.index) / this.portals!.size) *
                CAROUSEL_RADIUS
            Body.setPosition(portalBody, { x, y })
          }
        }
      })
    })

    Events.on(this.engine, "collisionStart", (event) => {
      event.pairs.forEach(({ bodyA, bodyB }) => {
        if (
          (this.items?.has(bodyA.label) && this.avatars?.has(bodyB.label)) ||
          (this.avatars?.has(bodyA.label) && this.items?.has(bodyB.label))
        ) {
          // when avatar collides with an item
          const avatarBody = this.avatars?.has(bodyA.label) ? bodyA : bodyB
          const itemBody = this.items?.has(bodyA.label) ? bodyA : bodyB
          const avatar = this.avatars.get(avatarBody.label)
          const item = this.items.get(itemBody.label)

          if (avatar?.itemId === "" && item?.avatarId === "") {
            if (room.state.specialGameRule === SpecialGameRule.KECLEONS_SHOP) {
              const player = room.state.players.get(avatar.id)
              const client = room.clients.find(
                (cli) => cli.auth.uid === avatar.id
              )
              if ((player?.money ?? 0) < KECLEON_SHOP_COST) {
                // too poor to buy one item from kecleon's shop
                client?.send(Transfer.NPC_DIALOG, {
                  npc: "kecleon",
                  dialog: "tell_price"
                })
                return
              } else {
                client?.send(Transfer.NPC_DIALOG, {
                  npc: "kecleon",
                  dialog: "thank_you"
                })
                if (player) {
                  player.money -= KECLEON_SHOP_COST
                }
              }
            }

            const constraint = Constraint.create({
              bodyA: avatarBody,
              bodyB: itemBody
            })
            Composite.add(this.engine.world, constraint)
            avatar.itemId = item.id
            item.avatarId = avatar.id

            itemBody.collisionFilter.mask = 0 // item no longer collide
            avatarBody.collisionFilter.mask = 0 // player no longer collide after taking an item

            const player = this.alivePlayers.find((p) => p.id === avatar!.id)
            if (player && player.isBot) {
              // make bots return to outer circle
              const i = this.alivePlayers.indexOf(player)
              avatar.targetX =
                this.centerX +
                Math.cos((2 * Math.PI * i) / this.alivePlayers.length) * 300
              avatar.targetY =
                this.centerY +
                Math.sin((2 * Math.PI * i) / this.alivePlayers.length) * 250
            }
          }
        }

        if (
          (this.portals?.has(bodyA.label) && this.avatars?.has(bodyB.label)) ||
          (this.avatars?.has(bodyA.label) && this.portals?.has(bodyB.label))
        ) {
          // when avatar collides with a portal
          const avatarBody = this.avatars?.has(bodyA.label) ? bodyA : bodyB
          const portalBody = this.portals?.has(bodyA.label) ? bodyA : bodyB
          const avatar = this.avatars.get(avatarBody.label)
          const portal = this.portals.get(portalBody.label)

          if (avatar?.portalId === "" && portal?.avatarId === "") {
            //logger.debug(`${avatar.name} is taking portal ${portal.id}`)
            portal.avatarId = avatar.id
            avatar.portalId = portal.id
            Composite.remove(this.engine.world, avatarBody)
            Composite.remove(this.engine.world, portalBody)
            this.bodies.delete(avatar.id)
            this.bodies.delete(portal.id)
          }
        }
      })
    })
  }

  create(
    avatars: MapSchema<PokemonAvatarModel>,
    items: MapSchema<FloatingItem>,
    portals: MapSchema<Portal>,
    symbols: MapSchema<SynergySymbol>
  ) {
    this.avatars = avatars
    this.items = items
    this.portals = portals
    this.symbols = symbols
  }

  initialize(state: GameState, room: GameRoom) {
    const { players, stageLevel, specialGameRule } = state
    this.alivePlayers = new Array<Player>()
    players.forEach((p) => {
      if (p.alive) {
        this.alivePlayers.push(p)
      }
    })
    this.alivePlayers.forEach((player, i) => {
      const x =
        this.centerX +
        Math.cos((2 * Math.PI * i) / this.alivePlayers.length) * 300
      const y =
        this.centerY +
        Math.sin((2 * Math.PI * i) / this.alivePlayers.length) * 250
      let retentionDelay =
        4000 + (this.alivePlayers.length - player.rank) * 2000
      if (stageLevel < 5) {
        retentionDelay = 5000
      }
      if (PortalCarouselStages.includes(stageLevel)) {
        retentionDelay = 8000
      }
      if (player.isBot) {
        retentionDelay += randomBetween(1000, 6000)
      }

      if (
        ItemCarouselStages.includes(stageLevel) &&
        state.specialGameRule === SpecialGameRule.KECLEONS_SHOP
      ) {
        if (player.money < KECLEON_SHOP_COST) {
          retentionDelay = Infinity
        }
      }

      const avatar = new PokemonAvatarModel(
        player.id,
        player.avatar,
        x,
        y,
        retentionDelay
      )

      if (player.isBot) {
        avatar.targetX =
          this.centerX +
          Math.cos((2 * Math.PI * i) / this.alivePlayers.length) *
            CAROUSEL_RADIUS
        avatar.targetY =
          this.centerY +
          Math.sin((2 * Math.PI * i) / this.alivePlayers.length) *
            CAROUSEL_RADIUS
      }

      this.avatars!.set(avatar.id, avatar)
      const body = Bodies.circle(x, y, 25)
      body.label = avatar.id
      body.collisionFilter.mask = 0 // disable collision until release time
      this.bodies.set(avatar.id, body)
      Composite.add(this.engine.world, body)
    })

    if (PortalCarouselStages.includes(stageLevel)) {
      this.initializePortalCarousel()
      room.broadcast(
        Transfer.PRELOAD_MAPS,
        values(this.portals!).map((p) => p.map)
      )
    } else if (ItemCarouselStages.includes(stageLevel)) {
      this.initializeItemsCarousel(stageLevel, specialGameRule)
    }
  }

  initializeItemsCarousel(
    stageLevel: number,
    specialGameRule: SpecialGameRule | null
  ) {
    const items = this.pickRandomItems(stageLevel, specialGameRule)

    for (let j = 0; j < items.length; j++) {
      const x = this.centerX + Math.cos((Math.PI * 2 * j) / items.length) * 100
      const y = this.centerY + Math.sin((Math.PI * 2 * j) / items.length) * 90
      const name = items[j]
      const floatingItem = new FloatingItem(name, x, y, j)
      this.items?.set(floatingItem.id, floatingItem)
      const body = Bodies.circle(x, y, 20)
      body.label = floatingItem.id
      body.isSensor = true
      this.bodies.set(floatingItem.id, body)
      Composite.add(this.engine.world, body)
    }
  }

  initializePortalCarousel() {
    const nbPortals = clamp(this.alivePlayers.length + 1, 3, 9)
    for (let i = 0; i < nbPortals; i++) {
      const x = this.centerX + Math.cos((Math.PI * 2 * i) / nbPortals) * 115
      const y = this.centerY + Math.sin((Math.PI * 2 * i) / nbPortals) * 115
      const portal = new Portal(x, y, i)
      this.portals?.set(portal.id, portal)
      const body = Bodies.circle(x, y, 30)
      body.label = portal.id
      body.isSensor = true
      this.bodies.set(portal.id, body)
      Composite.add(this.engine.world, body)
    }

    this.pickRandomSynergySymbols()
  }

  update(dt: number) {
    Engine.update(this.engine, dt)
    this.avatars?.forEach((a) => {
      if (a.timer > 0) {
        a.timer = a.timer - dt
      }
    })
    this.bodies.forEach((body, id) => {
      if (
        body.position.x < 0 ||
        body.position.x > 720 ||
        body.position.y < 0 ||
        body.position.y > 590
      ) {
        // prevent going out of bounds in case of lag
        Body.setPosition(body, {
          x: clamp(body.position.x, 0, 720),
          y: clamp(body.position.y, 0, 590)
        })
      }
      if (this.avatars?.has(id)) {
        const avatar = this.avatars.get(id)!
        avatar.x = body.position.x
        avatar.y = body.position.y
        this.updatePlayerVector(id)
      } else if (this.items?.has(id)) {
        const item = this.items.get(id)!
        item.x = body.position.x
        item.y = body.position.y
      } else if (this.portals?.has(id)) {
        const portal = this.portals.get(id)!
        portal.x = body.position.x
        portal.y = body.position.y
        const t = this.engine.timing.timestamp * SYMBOL_ROTATION_SPEED
        const symbols = this.symbolsByPortal.get(portal.id) ?? []
        symbols.forEach((symbol) => {
          symbol.x =
            portal.x +
            Math.cos(t + (Math.PI * 2 * symbol.index) / symbols.length) * 25
          symbol.y =
            portal.y +
            Math.sin(t + (Math.PI * 2 * symbol.index) / symbols.length) * 25
        })
      }
    })
  }

  pickRandomItems(
    stageLevel: number,
    specialGameRule: SpecialGameRule | null
  ): Item[] {
    const items: Item[] = []

    let nbItemsToPick = clamp(this.alivePlayers.length + 3, 5, 9)
    let maxCopiesPerItem = 2
    let itemsSet = ItemComponents

    if (stageLevel >= 20) {
      // Carousels after stage 20 propose full items and no longer components, and have one more proposition
      nbItemsToPick += 1
      maxCopiesPerItem = 1
      itemsSet = CraftableItems
    }

    if (specialGameRule === SpecialGameRule.SYNERGY_WHEEL) {
      itemsSet = SynergyStones
      maxCopiesPerItem = 4
    }

    if (specialGameRule === SpecialGameRule.KECLEONS_SHOP) {
      itemsSet = CraftableItems
      maxCopiesPerItem = 1
      nbItemsToPick = 6
    }

    for (let j = 0; j < nbItemsToPick; j++) {
      let item,
        count,
        tries = 0
      do {
        item = pickRandomIn(itemsSet)
        count = items.filter((i) => i === item).length
        tries++
      } while (count >= maxCopiesPerItem && tries < 10)
      items.push(item)
    }
    return items
  }

  pickRandomSynergySymbols() {
    this.avatars?.forEach((avatar) => {
      const player = this.alivePlayers.find((p) => p.id === avatar.id)!
      const synergiesTriggerLevels: [Synergy, number][] = Array.from(
        player.synergies
      ).map(([type, value]) => {
        const lastTrigger = SynergyTriggers[type]
          .filter((n) => n <= value)
          .at(-1)
        let levelReached = lastTrigger
          ? SynergyTriggers[type].indexOf(lastTrigger) + 1
          : 0
        // removing low triggers synergies
        if (type === Synergy.FLORA || type === Synergy.LIGHT)
          levelReached = min(0)(levelReached - 1)
        if (type === Synergy.GOURMET && levelReached > 1) levelReached = 1 // to compensate for the current lack of diversity in the legendary pool
        return [type, levelReached]
      })
      const candidatesSymbols: Synergy[] = []
      synergiesTriggerLevels.forEach(([type, level]) => {
        // add as many symbols as synergy levels reached
        candidatesSymbols.push(...new Array(level).fill(type))
      })
      //logger.debug("symbols from synergies", candidatesSymbols)
      if (candidatesSymbols.length < 4) {
        // if player has reached less than 4 synergy level triggers, we complete with random other incomplete synergies
        const incompleteSynergies = synergiesTriggerLevels
          .filter(
            ([type, level]) => level === 0 && player.synergies.get(type)! > 0
          )
          .map(([type, _level]) => type)
        candidatesSymbols.push(
          ...pickNRandomIn(incompleteSynergies, 4 - candidatesSymbols.length)
        )
        /*logger.debug(
          "completing symbols with incomplete synergies",
          incompleteSynergies
        )*/
      }
      while (candidatesSymbols.length < 4) {
        // if still incomplete, complete with random
        candidatesSymbols.push(pickRandomIn(Synergy))
        /*logger.debug(
          "completing symbols with random synergies",
          candidatesSymbols
        )*/
      }

      const symbols = pickNRandomIn(candidatesSymbols, NB_SYMBOLS_PER_PLAYER)
      //logger.debug(`symbols chosen for player ${player.name}`, symbols)
      symbols.forEach((type, i) => {
        const symbol = new SynergySymbol(avatar.x, avatar.y, type, i)
        this.symbols?.set(symbol.id, symbol)
      })
    })

    // randomly distribute symbols across portals
    const portalIds = shuffleArray(keys(this.portals!))
    const symbols = shuffleArray(values(this.symbols!))
    this.symbolsByPortal = new Map()

    symbols.forEach((symbol, i) => {
      const portalId = portalIds[i % portalIds.length]
      this.symbolsByPortal.set(portalId, [
        ...(this.symbolsByPortal.get(portalId) ?? []),
        symbol
      ])
      setTimeout(
        () => {
          symbol.index = Math.floor(i / portalIds.length)
          symbol.portalId = portalId
        },
        1500 + 1500 * (i / symbols.length)
      )
    })

    // assign a map to each portal
    const maps = new Set(Object.values(DungeonPMDO))
    this.portals?.forEach((portal) => {
      const symbols = this.symbolsByPortal.get(portal.id)
      const portalSynergies = (symbols ?? []).map((s) => s.synergy)
      let nbMaxInCommon = 0,
        candidateMaps: DungeonPMDO[] = []
      maps.forEach((map) => {
        const synergies = DungeonDetails[map].synergies
        const inCommon = synergies.filter((s) => portalSynergies.includes(s))
        if (inCommon.length > nbMaxInCommon) {
          nbMaxInCommon = inCommon.length
          candidateMaps = [map]
        } else if (inCommon.length === nbMaxInCommon) {
          candidateMaps.push(map)
        }
      })

      portal.map = pickRandomIn(candidateMaps)
      maps.delete(portal.map) // a map can't be taken twice
    })
  }

  applyVector(id: string, x: number, y: number) {
    const avatar = this.avatars?.get(id)
    if (avatar && avatar.timer <= 0) {
      avatar.targetX = avatar.x + x
      avatar.targetY = avatar.y - y
      this.updatePlayerVector(id)
    }
  }

  updatePlayerVector(id: string) {
    const avatar = this.avatars?.get(id)
    const body = this.bodies.get(id)
    if (body && avatar && avatar.timer <= 0) {
      if (!avatar.itemId) {
        body.collisionFilter.mask = 1 // activate collision if moving avatar without item
      }

      const distanceToTarget = Math.sqrt(
        (avatar.targetX - avatar.x) ** 2 + (avatar.targetY - avatar.y) ** 2
      )
      if (distanceToTarget > PLAYER_VELOCITY) {
        avatar.action = PokemonActionState.WALK
        let moveVector = Vector.sub(
          Vector.create(avatar.targetX, avatar.targetY),
          Vector.create(avatar.x, avatar.y)
        )
        avatar.orientation = getOrientation(
          0,
          0,
          moveVector.x,
          -1 * moveVector.y
        )
        moveVector = Vector.normalise(moveVector)
        moveVector = Vector.mult(moveVector, PLAYER_VELOCITY)
        Body.setVelocity(body, moveVector)
      } else {
        avatar.action = PokemonActionState.IDLE
        Body.setVelocity(body, Vector.create(0, 0))
      }
    }
  }

  stop(room: GameRoom) {
    const state: GameState = room.state
    const players: MapSchema<Player> = state.players
    this.bodies.forEach((body, key) => {
      Composite.remove(this.engine.world, body)
      this.bodies.delete(key)
    })
    this.avatars!.forEach((avatar) => {
      const player = players.get(avatar.id)
      if (
        avatar.itemId === "" &&
        player &&
        !player.isBot &&
        this.items &&
        state.specialGameRule !== SpecialGameRule.KECLEONS_SHOP
      ) {
        // give a random item if none was taken
        const remainingItems = [...this.items.entries()].filter(
          ([_itemId, item]) => item.avatarId == ""
        )
        if (remainingItems.length > 0) {
          avatar.itemId = pickRandomIn(remainingItems)[0]
        }
      }

      if (avatar.portalId == "" && player && !player.isBot) {
        // random propositions if no portal was taken
        avatar.portalId = "random"
      }

      if (avatar.itemId) {
        const item = this.items?.get(avatar.itemId)
        if (item && player && !player.isBot) {
          player.items.push(item.name)
        }
      }

      if (player && PortalCarouselStages.includes(state.stageLevel)) {
        if (avatar.portalId && this.portals?.has(avatar.portalId)) {
          const portal = this.portals.get(avatar.portalId)!
          player.map = portal.map
          player.updateRegionalPool(state, true)
        }

        const symbols = this.symbolsByPortal.get(avatar.portalId) ?? []
        const portalSynergies = symbols.map((s) => s.synergy)
        if (state.stageLevel > 1) {
          state.shop.assignUniquePropositions(
            player,
            state.stageLevel,
            portalSynergies
          )
        }
      }

      this.avatars!.delete(avatar.id)
    })

    if (this.items) {
      this.items.forEach((item) => {
        this.items!.delete(item.id)
      })
    }

    if (this.portals) {
      this.portals.forEach((portal) => {
        this.portals!.delete(portal.id)
      })
    }

    if (this.symbols) {
      this.symbols.forEach((symbol) => {
        this.symbols!.delete(symbol.id)
      })
    }
  }
}
