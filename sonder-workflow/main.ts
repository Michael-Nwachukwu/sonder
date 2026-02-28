import { cre, Runner, type Runtime } from "@chainlink/cre-sdk";
import { onCronTrigger } from "./cronCallback";


type Config = {
    schedule: string;
    priceOracleAddress: string;
    lendingPoolAddress: string;
    marketRegistryAddress: string;
    polymarketTokenId: string;
    marketId: string;
    eventId: string;
    geminiModel: string;
    chainSelectorName: string;
    gasLimit: string;
    anomalyDropThreshold: string;
    warningHF: string;
    liquidationHF: string;
};

const initWorkflow = (config: Config) => {
    const cron = new cre.capabilities.CronCapability();

    return [
        cre.handler(
            cron.trigger({ schedule: config.schedule }),
            onCronTrigger
        ),
    ];
};

export async function main() {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
}

main();
