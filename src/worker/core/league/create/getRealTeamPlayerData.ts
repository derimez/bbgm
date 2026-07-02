import {
	RealPlayerPhotosSchema,
	RealTeamInfoSchema,
	type Conditions,
} from "../../../../common/types.ts";
import { idb } from "../../../db/index.ts";
import logEvent from "../../../util/logEvent.ts";
import seedRealOverrides from "../seedRealOverrides.ts";

const getRealTeamPlayerData = async (
	{
		fileHasPlayers,
		fileHasTeams,
	}: {
		fileHasPlayers: boolean;
		fileHasTeams: boolean;
	},
	conditions: Conditions | undefined,
) => {
	let realPlayerPhotos;
	let realTeamInfo;
	if (fileHasPlayers || fileHasTeams) {
		// Ensure the fork's real team info + player photos are seeded before we read
		// them, so generated real-roster leagues bake in real logos and photos.
		await seedRealOverrides();

		const attributesStore = (await idb.meta.transaction("attributes")).store;
		if (fileHasPlayers) {
			const raw = await attributesStore.get("realPlayerPhotos");
			if (raw !== undefined) {
				const result = RealPlayerPhotosSchema.safeParse(raw);
				if (result.success) {
					realPlayerPhotos = result.data;
				} else {
					console.error(result.error);
					logEvent(
						{
							type: "error",
							text: "Invalid real player photos data ignored.",
							saveToDb: false,
						},
						conditions,
					);
				}
			}
		}
		if (fileHasTeams) {
			const raw = await attributesStore.get("realTeamInfo");
			if (raw !== undefined) {
				const result = RealTeamInfoSchema.safeParse(raw);
				if (result.success) {
					realTeamInfo = result.data;
				} else {
					console.error(result.error);
					logEvent(
						{
							type: "error",
							text: "Invalid real team info data ignored.",
							saveToDb: false,
						},
						conditions,
					);
				}
			}
		}
	}

	return {
		realPlayerPhotos,
		realTeamInfo,
	};
};

export default getRealTeamPlayerData;
