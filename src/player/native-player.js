/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import EventEmitter from 'events';
import PlayerEvents from './player-events.js';
import {createDefaultConfig} from '../config.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

// Player wrapper for browser's native player (HTMLVideoElement) without MediaSource src. 
class NativePlayer {

    constructor(mediaDataSource, config) {
        this.TAG = 'NativePlayer';
        this._type = 'NativePlayer';
        this._emitter = new EventEmitter();

        this._config = createDefaultConfig();
        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        if (mediaDataSource.type.toLowerCase() === 'flv') {
            throw new InvalidArgumentException('NativePlayer does\'t support flv MediaDataSource input!');
        }
        if (mediaDataSource.hasOwnProperty('segments')) {
            throw new InvalidArgumentException(`NativePlayer(${mediaDataSource.type}) doesn't support multipart playback!`);
        }

        this.e = {
            onvLoadedMetadata: this._onvLoadedMetadata.bind(this)
        };

        this._pendingSeekTime = null; // 预计跳帧
        this._statisticsReporter = null;

        this._mediaDataSource = mediaDataSource;
        this._mediaElement = null;
    }

    destroy() {
        if (this._mediaElement) {
            this.unload();
            this.detachMediaElement();
        }
        this.e = null;
        this._mediaDataSource = null;
        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        /**
         * 特殊拦截了两个事件
         */
        if (event === PlayerEvents.MEDIA_INFO) {
            if (this._mediaElement != null && this._mediaElement.readyState !== 0) {  // HAVE_NOTHING
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
                });
            }
        } else if (event === PlayerEvents.STATISTICS_INFO) {
            if (this._mediaElement != null && this._mediaElement.readyState !== 0) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
                });
            }
        }
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    attachMediaElement(mediaElement) {
        this._mediaElement = mediaElement;
        /**
         * when load meta data
         */
        mediaElement.addEventListener('loadedmetadata', this.e.onvLoadedMetadata);

        if (this._pendingSeekTime != null) {
            try {
                mediaElement.currentTime = this._pendingSeekTime;
                this._pendingSeekTime = null;
            } catch (e) {
                // IE11 may throw InvalidStateError if readyState === 0
                // Defer set currentTime operation after loadedmetadata
            }
        }
    }

    detachMediaElement() {
        if (this._mediaElement) {
            this._mediaElement.src = '';
            this._mediaElement.removeAttribute('src');
            this._mediaElement.removeEventListener('loadedmetadata', this.e.onvLoadedMetadata);
            this._mediaElement = null;
        }
        if (this._statisticsReporter != null) {
            window.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    load() {
        if (!this._mediaElement) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }
        /**
         * 设置video的src // native player
         */
        this._mediaElement.src = this._mediaDataSource.url;

        /**
         * The HTMLMediaElement.readyState property indicates the readiness state of the media.
         * https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
         */
        if (this._mediaElement.readyState > 0) {
            this._mediaElement.currentTime = 0;
        }

        this._mediaElement.preload = 'auto';
        this._mediaElement.load();
        this._statisticsReporter = window.setInterval(
            /**
             * 定时信息统计
             */
            this._reportStatisticsInfo.bind(this),
        this._config.statisticsInfoReportInterval);
    }

    unload() {
        if (this._mediaElement) {
            this._mediaElement.src = '';
            this._mediaElement.removeAttribute('src');
        }
        if (this._statisticsReporter != null) {
            window.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    play() {
        return this._mediaElement.play();
    }

    pause() {
        this._mediaElement.pause();
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._mediaElement.buffered;
    }

    get duration() {
        return this._mediaElement.duration;
    }

    get volume() {
        return this._mediaElement.volume;
    }

    set volume(value) {
        this._mediaElement.volume = value;
    }

    get muted() {
        return this._mediaElement.muted;
    }

    set muted(muted) {
        this._mediaElement.muted = muted;
    }

    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    set currentTime(seconds) {
        if (this._mediaElement) {
            this._mediaElement.currentTime = seconds;
        } else {
            this._pendingSeekTime = seconds;
        }
    }

    get mediaInfo() {
        /**
         * 返回一个mediaInfo对象, 包含
         * mimeTpye: 音频或视频 + 播放类型
         * duration: 资源时长
         * width, height: 如果是视频则包含 宽高
         */
        let mediaPrefix = (this._mediaElement instanceof HTMLAudioElement) ? 'audio/' : 'video/';
        let info = {
            mimeType: mediaPrefix + this._mediaDataSource.type
        };
        if (this._mediaElement) {
            // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/duration
            // 时长
            info.duration = Math.floor(this._mediaElement.duration * 1000);
            if (this._mediaElement instanceof HTMLVideoElement) {
                // 如果是视频 再拿宽高
                info.width = this._mediaElement.videoWidth;
                info.height = this._mediaElement.videoHeight;
            }
        }
        return info;
    }

    get statisticsInfo() {
        /**
         * 生成一个播放对象
         * 播放类型(NativePlayer)
         * 播放的url
         * 播放质量
         *  - 总帧
         *  - 丢帧
         */
        let info = {
            playerType: this._type,
            url: this._mediaDataSource.url
        };

        if (!(this._mediaElement instanceof HTMLVideoElement)) {
            return info;
        }

        let hasQualityInfo = true;
        let decoded = 0;
        let dropped = 0;

        if (this._mediaElement.getVideoPlaybackQuality) {
            /**
             * getVideoPlaybackQuality 会返回一个当前播放质量的对象
             * https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality
             * https://developer.mozilla.org/en-US/docs/Web/API/VideoPlaybackQuality
             */
            let quality = this._mediaElement.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames; // 总帧 = 创建的 + 丢弃的
            dropped = quality.droppedVideoFrames; // 被丢弃的帧
        } else if (this._mediaElement.webkitDecodedFrameCount != undefined) {
            decoded = this._mediaElement.webkitDecodedFrameCount;
            dropped = this._mediaElement.webkitDroppedFrameCount;
        } else {
            hasQualityInfo = false;
        }

        if (hasQualityInfo) {
            info.decodedFrames = decoded;
            info.droppedFrames = dropped;
        }
        
        return info;
    }

    _onvLoadedMetadata(e) {
        if (this._pendingSeekTime != null) {
            this._mediaElement.currentTime = this._pendingSeekTime;
            this._pendingSeekTime = null;
        }
        /**
         * 广播一个 media_info 事件，包含信息 this.mediaInfo
         */
        this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
    }

    _reportStatisticsInfo() {
        /**
         * 广播一个 statistics_info 事件，包含信息 this.statisticsInfo
         */
        this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
    }

}

export default NativePlayer;