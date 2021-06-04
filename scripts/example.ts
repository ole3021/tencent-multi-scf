import { join } from 'path';
import * as dotenv from 'dotenv';
import * as ora from 'ora';
import * as chalk from 'chalk';
import { program } from 'commander';
import { getExampleConfig, getServerlessSdk } from './utils';
import { COMPONENT_NAME } from './config';

dotenv.config({
  path: join(__dirname, '..', '.env.test'),
});

const credentials = {
  tencent: {
    SecretId: process.env.TENCENT_SECRET_ID,
    SecretKey: process.env.TENCENT_SECRET_KEY,
  },
};

function parseInputs(inputs: string) {
  const inputObject: { [key: string]: any } = {};
  if (!inputs) {
    return inputObject;
  }
  try {
    inputs.split(',').forEach((item) => {
      const [key, value] = item.split('=');
      if (key.indexOf('.') !== -1) {
        const keyArr = key.split('.');
        const len = keyArr.length;
        let index = 0;
        let curObj = inputObject;

        while (index < len) {
          const curKey = keyArr[index];
          if (!curObj[curKey]) {
            curObj[curKey] = index === len - 1 ? value : {};
          }
          curObj = curObj[curKey];
          index++;
        }
      } else {
        inputObject[key] = value;
      }
    });
  } catch (e) {}
  return inputObject;
}

async function deploy(options: { [propName: string]: any }) {
  const { examplePath, yamlConfig } = getExampleConfig();
  const appId = process.env.TENCENT_APP_ID as string;

  if (options.template) {
    delete yamlConfig.inputs.src;
  } else {
    yamlConfig.inputs.src = {
      src: examplePath,
      exclude: ['.env'],
    };
  }

  yamlConfig.org = appId;

  if (options.dev) {
    yamlConfig.component = `${COMPONENT_NAME}@dev`;
  } else {
    yamlConfig.component = COMPONENT_NAME;
  }

  const sdk = getServerlessSdk(appId, appId);

  const stage = options.env || 'dev';
  process.env.SERVERLESS_PLATFORM_STAGE = stage;

  if (stage === 'dev') {
    yamlConfig.component = `${COMPONENT_NAME}@dev`;
  }

  // merge customize inputs parameters
  const inputs = parseInputs(options.inputs);
  yamlConfig.inputs = {
    ...yamlConfig.inputs,
    ...inputs,
  };

  const spinner = ora().start(`Start deploying example...\n`);

  // remove deploy instance
  if (options.remove) {
    spinner.info(`Removing example (${stage})...`);
    await sdk.remove(yamlConfig, credentials);
    spinner.succeed(`Remove example success`);
  } else {
    // deploy
    spinner.info(`Deploying example (${stage})...`);
    const res = await sdk.deploy(yamlConfig, credentials);
    spinner.succeed(`Deploy example success`);

    console.log(
      chalk.bgGreen('\n', chalk.black(` OUTPUTS `)),
      '\n',
      chalk.yellow(JSON.stringify(res.outputs, null, 2)),
    );
  }

  spinner.stop();
}

async function run() {
  program
    .description('Deploy example')
    .option('-e, --env [env]', 'specify environment for component service: prod,dev', 'dev')
    .option('-d, --dev [dev]', 'use dev version component')
    .option('-t, --template [template]', 'use template to deploy')
    .option('-r, --remove [remove]', 'remove example')
    .option('-i, --inputs [inputs]', 'customize inputs')
    .action((options) => {
      deploy(options);
    });

  program.parse(process.argv);
}

run();
