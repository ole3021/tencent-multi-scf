import { Cos } from 'tencent-component-toolkit';
import {
  Credentials,
  Inputs,
  SrcObject,
  FaasInputs,
  TriggerInputs,
  TriggerSdkInputs,
  FormatOptions,
  FormatOutputs,
  FormatTriggerOptions,
  ComponentInstance,
  ApigwState,
} from './interface';
import { CONFIGS } from './config';
import { ApiError } from 'tencent-component-toolkit/lib/utils/error';
import { randomId, getType, removeAppId } from './utils';

function getDefaultBucketName(region: string) {
  return `sls-cloudfunction-${region}-code`;
}

function getDefultObjectName(compName: string) {
  return `/${compName}_${randomId()}-${Math.floor(Date.now() / 1000)}.zip`;
}

async function uploadCodeToCos({
  credentials,
  appId,
  inputs,
}: {
  credentials: Credentials;
  appId: string;
  inputs: Inputs;
}) {
  const region = inputs.region || CONFIGS.region;
  const { srcOriginal } = inputs;
  inputs.srcOriginal = inputs.srcOriginal || inputs.src;

  const tempSrc = (getType(srcOriginal) === 'Object'
    ? srcOriginal
    : getType(srcOriginal) === 'String'
    ? {
        src: srcOriginal,
      }
    : {}) as SrcObject;

  // 如果没配置 bucket，使用默认 bucket，默认名称复用老的逻辑
  const bucketName = tempSrc!.bucket
    ? removeAppId(tempSrc.bucket, appId)
    : getDefaultBucketName(region);

  const objectName = tempSrc.object || getDefultObjectName(CONFIGS.compName);

  const cos = new Cos(credentials, region);
  const bucket = `${bucketName}-${appId}`;

  // create new bucket, and setup lifecycle for it
  if (!tempSrc.bucket) {
    await cos.deploy({
      bucket,
      force: true,
      lifecycle: CONFIGS.cos.lifecycle,
    });
  }

  if (!tempSrc.object) {
    console.log(`Uploading code ${objectName} to bucket ${bucket}`);
    await cos.upload({
      bucket,
      file: inputs.src as string,
      key: objectName,
    });
  }

  return {
    code: {
      bucket: bucketName,
      object: objectName,
    },
  };
}

function getApigwState(name: string, instance: ComponentInstance): ApigwState {
  const { state } = instance;
  const triggersList = state.triggers;
  if (!triggersList) {
    return {} as ApigwState;
  }
  let apigwState = {} as ApigwState;
  loopA: for (const item of triggersList) {
    const { triggers } = item;
    for (const curT of triggers) {
      if (curT.serviceId && curT.serviceName === name) {
        apigwState = curT as ApigwState;
        break loopA;
      }
    }
  }

  return apigwState;
}

function formatScfName({
  instance,
  functionKey,
}: {
  instance: ComponentInstance;
  functionKey: string;
}) {
  return `${instance.name}-${instance.stage}-${instance.app}-${functionKey}`;
}

// 格式化触发器参数
export function formatTriggerInputs({
  triggers = [],
  instance,
  commandFunctionKey,
  functionNameMap,
  function: { namespace = 'default' },
}: FormatTriggerOptions): TriggerSdkInputs[] {
  // 格式化触发器参数，输入底层依赖 SDK
  const triggersInputsList: TriggerInputs[] = [];
  triggers.forEach((item: TriggerInputs) => {
    item.namespace = namespace;
    let isNeeded = commandFunctionKey ? false : true;
    if (item.type === 'apigw') {
      const serviceName = item.parameters.name;
      const apigwState = getApigwState(serviceName, instance);

      item.parameters.serviceId = item.parameters.id || apigwState.serviceId;
      item.parameters.serviceName = serviceName;

      // 定制化需求：是否在 yaml 文件中配置了 apigw 触发器的 serviceId
      item.parameters.isInputServiceId = !!item.parameters.id;

      const apiList = item.parameters.apis?.filter((api) => {
        const functionKey = api.function as string;
        api.function = {
          name: functionNameMap[functionKey],
          functionName: functionNameMap[functionKey],
          functionNamespace: namespace,
          functionQualifier: item.parameters.qualifier,
        };

        if (commandFunctionKey) {
          if (commandFunctionKey === functionKey) {
            isNeeded = true;
            return true;
          }
          return false;
        }
        isNeeded = true;
        return true;
      });

      item.parameters.endpoints = apiList;
      item.parameters.oldState = apigwState;
    } else {
      const functionKey = item.function as string;
      if (commandFunctionKey) {
        if (commandFunctionKey === functionKey) {
          isNeeded = true;
        } else {
          isNeeded = false;
        }
      } else {
        isNeeded = true;
      }
      item.function = {
        name: functionNameMap[functionKey],
      };
    }

    if (isNeeded) {
      triggersInputsList.push(item);
    }
  });
  return triggersInputsList as TriggerSdkInputs[];
}

export function formatFaasInputs({
  inputs,
}: {
  instance?: ComponentInstance;
  inputs: FaasInputs;
}): FaasInputs {
  const { environment = [], tags = [] } = inputs;
  if (environment instanceof Array) {
    const newEnvs: { [key: string]: string } = {};
    environment.forEach(({ key, value }) => {
      newEnvs[key] = value;
    });
    inputs.environment = {
      variables: newEnvs,
    };
  }
  if (tags instanceof Array) {
    const newTags: Record<string, string> = {};
    tags.forEach(({ key, value }) => {
      newTags[key] = value;
    });

    inputs.tags = newTags;
  }
  if (inputs.vpc) {
    inputs.vpcConfig = inputs.vpc;
  }

  return inputs;
}

// 格式化云函数参数
export const formatInputs = async ({
  inputs,
  credentials,
  appId,
  instance,
  commandFunctionKey,
}: FormatOptions): Promise<FormatOutputs> => {
  const region = inputs.region || CONFIGS.region;
  const { code } = await uploadCodeToCos({ credentials, appId, inputs });

  const commonInputs = {
    namespace: inputs.namespace || CONFIGS.namespace,
    runtime: inputs.runtime || CONFIGS.runtime,
    description: inputs.description || CONFIGS.description,
    code,
  };

  const scfInputsList: FaasInputs[] = [];
  const { functions } = inputs;

  let isFunctionExist = false;

  const functionNameMap: { [key: string]: string } = {};
  Object.entries(functions).forEach(([key, func]) => {
    const scfInputs = {
      ...commonInputs,
      ...func,
    };

    const formatedName = formatScfName({ instance, functionKey: key });
    // 如果指定了函数名称，则过滤
    if (commandFunctionKey) {
      if (key === commandFunctionKey) {
        scfInputs.name = scfInputs.name || formatedName;
        scfInputsList.push(scfInputs);
        isFunctionExist = true;
      }
    } else {
      scfInputs.name = scfInputs.name || formatedName;
      scfInputsList.push(scfInputs);
    }
    functionNameMap[key] = scfInputs.name!;
  });

  // 如果指定了函数，但是没法找到，就报错
  if (commandFunctionKey && !isFunctionExist) {
    throw new ApiError({
      type: 'MULTI-SCF_PARAMETERS_ERROR',
      message: `指定函数别名(${commandFunctionKey})不存在`,
    });
  }

  const triggerInputsList = formatTriggerInputs({
    triggers: inputs.triggers,
    instance,
    commandFunctionKey,
    functionNameMap,
    function: {
      namespace: inputs.namespace,
    },
  });

  return {
    region,
    scfInputsList,
    triggerInputsList,
  };
};
