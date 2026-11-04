import { beforeEach } from "vitest";
import { installFakes } from "./fakeRail.js";
import { setWalletActivity } from "../src/rails/onchain.js";
// Model-free and network-free by default. The sandbox contract file swaps the real adapters back in.
beforeEach(() => { installFakes(); setWalletActivity(async () => ({ txCount: 3, network: "base-sepolia", checkedAt: "fixture" })); });
import { parseSdn, setSdnIndex } from "../src/modules/sdn.js";
// A tiny invented SDN fixture so screening never depends on the downloaded list.
const FIXTURE = `36001,"VOLGA SHADOW TRADING LLC","-0- ","SDGT] [CYBER2","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Digital Currency Address - ETH 0xd00d00000000000000000000000000000000d00d; alt. Digital Currency Address - XBT bc1qfixture000"\n36002,"KRASNY, Ivan","individual","SDGT","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","DOB 01 Jan 1970."\n`;
const ALT = `36001,9001,"aka","NORTHERN LIGHT METALS",-0- \n`;
beforeEach(() => { setSdnIndex({ ...parseSdn(FIXTURE, ALT), fetchedAt: "fixture" }); });
