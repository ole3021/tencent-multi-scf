import { FaasKeyMap } from './interface/index';
import { mkdirSync } from 'fs';
import { join as pathJoin } from 'path';
import { sync as rmSync } from 'rimraf';
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
import { getType, randomId, removeAppId, getTimestamp, deepClone } from './utils';
import { zip, unzip } from './zipper';

function getDefaultBucketName(region: string) {
  return `sls-cloudfunction-${region}-code`;
}

function getDefultObjectName(instance: ComponentInstance) {
  return `${instance.name}-${instance.stage}-${instance.app}-${randomId()}-${getTimestamp()}.zip`;
}

async function uploadCodeToCos({
  instance,
  credentials,
  appId,
  inputs,
  faasInputsList,
}: {
  instance: ComponentInstance;
  credentials: Credentials;
  appId: string;
  inputs: Inputs;
  faasInputsList: FaasInputs[];
}): Promise<FaasInputs[]> {
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

  const cos = new Cos(credentials, region);
  const bucket = `${bucketName}-${appId}`;

  // 如果桶没有指定，则创建默认桶
  if (!tempSrc.bucket) {
    await cos.deploy({
      bucket,
      force: true,
      lifecycle: CONFIGS.cos.lifecycle,
    });
  }

  // 此标识为了防止全量代码重复上传，不同函数如果没有指定子目录（src)，可以复用代码
  let whileCodeUploaded = false;
  const defaultObjectName = getDefultObjectName(instance);

  async function uploadFaasCode(faasConfig: FaasInputs) {
    const scfCodeSrc = faasConfig.src?.replace('./', '');
    const zipFile = inputs.src as string;
    if (scfCodeSrc) {
      const scfObjectName = `${faasConfig.name}-${randomId()}-${getTimestamp()}.zip`;
      // 上传子目录代码
      const scfPath = `/tmp/${faasConfig.name}`;
      mkdirSync(scfPath);

      // 将函数代码解压到指定目录
      await unzip({
        filename: zipFile,
        target: `${scfPath}/code`,
        overwrite: true,
        entryName: scfCodeSrc,
      });
      const scfZipPath = `${scfPath}/${scfObjectName}`;
      // 将函数代码压缩到指定目录
      await zip({
        src: pathJoin(`${scfPath}/code`, faasConfig.src!),
        filename: scfZipPath,
      });
      console.log(`Uploading code ${scfObjectName} to bucket ${bucket}`);

      await cos.upload({
        bucket,
        file: scfZipPath,
        key: scfObjectName,
      });

      // 清理函数代码缓存：代码目录和zip包
      rmSync(scfPath);

      return {
        bucket: bucketName,
        object: scfObjectName,
      };
    }
    if (!whileCodeUploaded) {
      // 上传全量代码
      console.log(`Uploading code ${defaultObjectName} to bucket ${bucket}`);
      await cos.upload({
        bucket,
        file: zipFile,
        key: defaultObjectName,
      });
      whileCodeUploaded = true;
    }
    return {
      bucket: bucketName,
      object: defaultObjectName,
    };
  }
  for (let i = 0; i < faasInputsList.length; i++) {
    const curScf = faasInputsList[i];
    if (!curScf.image) {
      const code = await uploadFaasCode(curScf);
      faasInputsList[i].code = code;
    } else {
      // 镜像类型不需要上传代码
      const {
        registryId,
        imageUrl,
        imageType = 'personal',
        command: imageCommand,
        args: imageArgs,
      } = curScf.image;
      // 企业版需要配置 registryId (实例 ID)
      if (registryId) {
        faasInputsList[i].imageConfig = {
          imageType,
          imageUri: imageUrl,
          registryId,
          command: imageCommand,
          args: imageArgs,
        };
      } else {
        faasInputsList[i].imageConfig = {
          imageType,
          imageUri: imageUrl,
          command: imageCommand,
          args: imageArgs,
        };
      }
    }
  }

  return faasInputsList;
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
  faasKeyMap,
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
          name: faasKeyMap[functionKey].name,
          type: faasKeyMap[functionKey].type,
          functionName: faasKeyMap[functionKey].name,
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
        name: faasKeyMap[functionKey].name,
        type: faasKeyMap[functionKey].type,
        namespace: faasKeyMap[functionKey].namespace,
      };
    }

    if (isNeeded) {
      triggersInputsList.push(item);
    }
  });
  return triggersInputsList as TriggerSdkInputs[];
}

export function formatFaasInputs({ inputs }: { inputs: FaasInputs }): FaasInputs {
  const { environments = [], tags = [] } = inputs;
  if (environments instanceof Array) {
    const newEnvs: { [key: string]: string } = {};
    environments.forEach(({ key, value }) => {
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

  const commonInputs = deepClone({
    ...inputs,
    ...{
      type: inputs.type || CONFIGS.type,
      namespace: inputs.namespace || CONFIGS.namespace,
      runtime: inputs.runtime || CONFIGS.runtime,
      description: inputs.description || CONFIGS.description,
    },
  });
  delete commonInputs.src;

  let faasInputsList: FaasInputs[] = [];
  const { functions } = inputs;

  let isFunctionExist = false;

  const faasKeyMap: FaasKeyMap = {};
  Object.entries(functions).forEach(([key, func]) => {
    const curInputs = formatFaasInputs({
      inputs: {
        ...commonInputs,
        ...func,
      },
    });
    curInputs.key = key;

    const formatedName = formatScfName({ instance, functionKey: key });
    // 如果指定了函数名称，则过滤
    if (commandFunctionKey) {
      if (key === commandFunctionKey) {
        curInputs.name = curInputs.name || formatedName;
        faasInputsList.push(curInputs);
        isFunctionExist = true;
      }
    } else {
      curInputs.name = curInputs.name || formatedName;
      faasInputsList.push(curInputs);
    }
    faasKeyMap[key] = {
      name: curInputs.name!,
      type: curInputs.type,
      namespace: curInputs.namespace,
    };
  });

  faasInputsList = await uploadCodeToCos({ instance, credentials, appId, inputs, faasInputsList });

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
    faasKeyMap,
    function: {
      namespace: inputs.namespace,
    },
  });

  return {
    region,
    faasInputsList,
    triggerInputsList,
  };
};
